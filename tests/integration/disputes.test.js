process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { LedgerService } = require('../../src/modules/ledger');
const { runAutoComplete } = require('../../src/jobs/auto-complete');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');
const {
  fundedBuyer,
  addToCart,
  checkout,
  balanceOf,
  shippedSubOrder,
} = require('../helpers/orders');
const { signInVendor } = require('../helpers/vendors');
const { makeProduct } = require('../helpers/products');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
let admin;
beforeAll(async () => {
  admin = await signIn(app, { roles: ['buyer', 'admin'] });
});

const REASON = 'Item arrived damaged and does not work';
const open = (
  who,
  subId,
  body = {
    reason: REASON,
    evidence: [{ type: 'image', value: 'https://img.example.com/broken.jpg' }],
  },
) => request(app).post(`/api/v1/sub-orders/${subId}/disputes`).set(who.auth).send(body);
const resolve = (id, body, who = admin) =>
  request(app).patch(`/api/v1/disputes/${id}/resolve`).set(who.auth).send(body);
const statusOf = async (id) => (await postgres.db('sub_orders').where({ id }).first()).status;
const entriesOf = async (reference) => {
  const txn = await postgres.db('transactions').where({ reference }).first();
  return postgres.db('ledger_entries').where({ transaction_id: txn.id });
};
const net = (entries) =>
  entries.reduce((sum, e) => sum + (e.direction === 'credit' ? e.amount_kobo : -e.amount_kobo), 0);

describe('opening a dispute', () => {
  test('the buyer opens one on a SHIPPED sub-order; it becomes DISPUTED', async () => {
    const { buyer, sub } = await shippedSubOrder(app);
    const res = await open(buyer, sub.id);
    expect(res.status).toBe(201);
    expect(res.body.data.dispute).toMatchObject({
      subOrderId: sub.id,
      buyerId: buyer.userId,
      status: 'OPEN',
      reason: REASON,
      evidence: [{ type: 'image', value: 'https://img.example.com/broken.jpg' }],
    });
    expect(await statusOf(sub.id)).toBe('DISPUTED');
  });

  test('freezes escrow: auto-complete skips it even when overdue', async () => {
    const { buyer, sub } = await shippedSubOrder(app);
    await open(buyer, sub.id);
    await postgres
      .db('sub_orders')
      .where({ id: sub.id })
      .update({ auto_complete_at: postgres.db.raw("now() - interval '1 hour'") });
    await runAutoComplete();
    expect(await statusOf(sub.id)).toBe('DISPUTED');
  });

  test('a second dispute on the same sub-order is refused', async () => {
    const { buyer, sub } = await shippedSubOrder(app);
    await open(buyer, sub.id);
    expect((await open(buyer, sub.id)).body.error.code).toBe('DISPUTE_ALREADY_OPEN');
  });

  test('another buyer gets 404; evidence must be text or image URLs', async () => {
    const { buyer, sub } = await shippedSubOrder(app);
    const stranger = await signIn(app);
    expect((await open(stranger, sub.id)).status).toBe(404);
    const bad = { reason: REASON, evidence: [{ type: 'image', value: 'not a url' }] };
    expect((await open(buyer, sub.id, bad)).status).toBe(422);
  });

  test('a sub-order that has not shipped cannot be disputed (cancel instead)', async () => {
    const buyer = await fundedBuyer(app, 500000);
    const vendor = await signInVendor(app);
    await addToCart(app, buyer, (await makeProduct(app, vendor)).id, 1);
    const paid = (await checkout(app, buyer)).body.data.order.subOrders[0];
    const res = await open(buyer, paid.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_DISPUTABLE');
  });
});

describe('vendor reply', () => {
  test('the vendor replies once with their own evidence; others cannot', async () => {
    const { vendor, buyer, sub } = await shippedSubOrder(app);
    const dispute = (await open(buyer, sub.id)).body.data.dispute;
    const body = {
      response: 'It was packed safely; courier signed for it intact',
      evidence: [{ type: 'image', value: 'https://img.example.com/packed.jpg' }],
    };

    const other = await signInVendor(app);
    expect(
      (
        await request(app)
          .patch(`/api/v1/disputes/${dispute.id}/respond`)
          .set(other.auth)
          .send(body)
      ).status,
    ).toBe(404);

    const res = await request(app)
      .patch(`/api/v1/disputes/${dispute.id}/respond`)
      .set(vendor.auth)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.data.dispute).toMatchObject({
      vendorResponse: body.response,
      vendorEvidence: body.evidence,
    });

    const again = await request(app)
      .patch(`/api/v1/disputes/${dispute.id}/respond`)
      .set(vendor.auth)
      .send(body);
    expect(again.body.error.code).toBe('ALREADY_RESPONDED');

    // Both sides are visible to the admin and in each party's own list.
    const seen = await request(app).get(`/api/v1/disputes/${dispute.id}`).set(admin.auth);
    expect(seen.body.data.dispute).toMatchObject({ reason: REASON, vendorResponse: body.response });
    const mine = await request(app).get('/api/v1/disputes/mine').set(vendor.auth);
    expect(mine.body.data.items.map((d) => d.id)).toContain(dispute.id);
  });
});

describe('admin resolution', () => {
  // Required test 13
  test('a partial refund leaves the ledger balanced, with commission only on the vendor part', async () => {
    const { vendor, buyer, sub } = await shippedSubOrder(app, { priceKobo: 111111, qty: 3 });
    const dispute = (await open(buyer, sub.id)).body.data.dispute;
    const buyerBefore = await balanceOf(buyer.accountId);
    const vendorAccount = await LedgerService.openUserAccount(vendor.userId);

    const res = await resolve(dispute.id, {
      resolution: 'PARTIAL_REFUND',
      refundKobo: 100000,
      note: 'Minor damage; partial refund agreed',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.dispute).toMatchObject({
      status: 'RESOLVED',
      resolution: 'PARTIAL_REFUND',
      refundKobo: 100000,
      resolvedBy: admin.userId,
      note: 'Minor damage; partial refund agreed',
    });

    const entries = await entriesOf(`DSP-${dispute.id}`);
    expect(net(entries)).toBe(0);
    const [escrow, revenue] = await Promise.all([
      LedgerService.getSystemAccount('PLATFORM_ESCROW'),
      LedgerService.getSystemAccount('PLATFORM_REVENUE'),
    ]);
    const by = Object.fromEntries(entries.map((e) => [e.account_id, e.amount_kobo]));
    // 333,333 total: 100,000 back; 233,333 left; 5% = 11,666 (rounded down); vendor 221,667.
    expect(by[escrow.id]).toBe(333333);
    expect(by[buyer.accountId]).toBe(100000);
    expect(by[revenue.id]).toBe(11666);
    expect(by[vendorAccount.id]).toBe(221667);

    expect(await balanceOf(buyer.accountId)).toBe(buyerBefore + 100000);
    expect(await statusOf(sub.id)).toBe('COMPLETED');
    expect((await LedgerService.audit()).ok).toBe(true);
  });

  test('a full refund returns the whole sub-order to the buyer and ends REFUNDED', async () => {
    const { vendor, buyer, sub } = await shippedSubOrder(app, { priceKobo: 70000, qty: 2 });
    const dispute = (await open(buyer, sub.id)).body.data.dispute;
    const buyerBefore = await balanceOf(buyer.accountId);
    const vendorBefore = (await LedgerService.openUserAccount(vendor.userId)).balanceKobo;

    const res = await resolve(dispute.id, {
      resolution: 'FULL_REFUND',
      note: 'Never delivered; courier confirms loss',
    });
    expect(res.body.data.dispute).toMatchObject({ resolution: 'FULL_REFUND', refundKobo: 140000 });
    expect(await balanceOf(buyer.accountId)).toBe(buyerBefore + 140000);
    expect((await LedgerService.openUserAccount(vendor.userId)).balanceKobo).toBe(vendorBefore);
    expect(await statusOf(sub.id)).toBe('REFUNDED');
  });

  test('rejected: escrow is released to the vendor as a normal completion', async () => {
    const { vendor, buyer, sub } = await shippedSubOrder(app, { priceKobo: 100000 });
    const dispute = (await open(buyer, sub.id)).body.data.dispute;
    const vendorBefore = (await LedgerService.openUserAccount(vendor.userId)).balanceKobo;

    const res = await resolve(dispute.id, {
      resolution: 'REJECTED',
      note: 'Tracking shows delivered and signed',
    });
    expect(res.body.data.dispute).toMatchObject({ resolution: 'REJECTED', refundKobo: 0 });
    expect((await LedgerService.openUserAccount(vendor.userId)).balanceKobo).toBe(
      vendorBefore + 95000,
    );
    expect(await statusOf(sub.id)).toBe('COMPLETED');
  });

  test('resolving twice, or two admins at once: exactly one resolution', async () => {
    const { buyer, sub } = await shippedSubOrder(app);
    const dispute = (await open(buyer, sub.id)).body.data.dispute;
    const body = { resolution: 'FULL_REFUND', note: 'Refund approved' };
    const results = await Promise.all([resolve(dispute.id, body), resolve(dispute.id, body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409).body.error.code).toBe('DISPUTE_ALREADY_RESOLVED');
    const refunds = await postgres.db('transactions').where({ reference: `DSP-${dispute.id}` });
    expect(refunds).toHaveLength(1);
  });

  test.each([
    [{ resolution: 'FULL_REFUND' }, 'note'],
    [{ resolution: 'FULL_REFUND', note: '   ' }, 'note'],
    [{ resolution: 'PARTIAL_REFUND', note: 'Partial agreed' }, 'refundKobo'],
    [{ resolution: 'PARTIAL_REFUND', refundKobo: 10.5, note: 'Partial agreed' }, 'refundKobo'],
    [{ resolution: 'REJECTED', refundKobo: 500, note: 'Rejected' }, 'refundKobo'],
  ])('bad resolution %o is a 422 on %s', async (body, field) => {
    const { buyer, sub } = await shippedSubOrder(app);
    const dispute = (await open(buyer, sub.id)).body.data.dispute;
    const res = await resolve(dispute.id, body);
    expect(res.status).toBe(422);
    expect(res.body.error.details).toHaveProperty(field);
  });

  test('a partial refund must be less than the sub-order total', async () => {
    const { buyer, sub } = await shippedSubOrder(app, { priceKobo: 50000 });
    const dispute = (await open(buyer, sub.id)).body.data.dispute;
    const res = await resolve(dispute.id, {
      resolution: 'PARTIAL_REFUND',
      refundKobo: 50000,
      note: 'All of it',
    });
    expect(res.status).toBe(422);
    expect(await statusOf(sub.id)).toBe('DISPUTED');
  });

  test('only admins can list, view and resolve', async () => {
    const { buyer, sub } = await shippedSubOrder(app);
    const dispute = (await open(buyer, sub.id)).body.data.dispute;
    expect((await request(app).get('/api/v1/disputes').set(buyer.auth)).status).toBe(403);
    expect(
      (await resolve(dispute.id, { resolution: 'FULL_REFUND', note: 'Self-approved' }, buyer))
        .status,
    ).toBe(403);
    const list = await request(app)
      .get('/api/v1/disputes')
      .query({ status: 'OPEN' })
      .set(admin.auth);
    expect(list.status).toBe(200);
    expect(list.body.data.items.every((d) => d.status === 'OPEN')).toBe(true);
  });
});
