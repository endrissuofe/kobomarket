process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { LedgerService } = require('../../src/modules/ledger');
const { releaseEscrow } = require('../../src/modules/orders/orders.service');
const { ordersRepository } = require('../../src/modules/orders/orders.repository');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');
const { signInVendor } = require('../helpers/vendors');
const { makeProduct } = require('../helpers/products');
const { fundedBuyer, addToCart, checkout, balanceOf } = require('../helpers/orders');

useMongo();
afterAll(() => postgres.close());

const app = createApp();

/** A buyer's single-vendor PAID sub-order. */
async function paidSubOrder({ priceKobo = 100000, qty = 1 } = {}) {
  const vendor = await signInVendor(app);
  const buyer = await fundedBuyer(app, 5_000_000);
  await addToCart(app, buyer, (await makeProduct(app, vendor, { priceKobo, stock: 10 })).id, qty);
  const order = (await checkout(app, buyer)).body.data.order;
  return { vendor, buyer, order, sub: order.subOrders[0] };
}
const ship = (who, subId, body = { courierName: 'GIG Logistics', trackingNumber: 'GIG-123456' }) =>
  request(app).patch(`/api/v1/sub-orders/${subId}/ship`).set(who.auth).send(body);
const confirm = (who, subId) =>
  request(app).patch(`/api/v1/sub-orders/${subId}/confirm`).set(who.auth);
const releaseEntries = async (subId) => {
  const txn = await postgres
    .db('transactions')
    .where({ reference: `SUB-${subId}-RELEASE` })
    .first();
  return txn ? postgres.db('ledger_entries').where({ transaction_id: txn.id }) : [];
};

describe('PATCH /sub-orders/:id/ship', () => {
  test('the owning vendor ships with courier and tracking; auto-complete is due in 72 hours', async () => {
    const { vendor, sub } = await paidSubOrder();
    const res = await ship(vendor, sub.id);
    expect(res.status).toBe(200);
    const shipped = res.body.data.subOrder;
    expect(shipped).toMatchObject({
      status: 'SHIPPED',
      courierName: 'GIG Logistics',
      trackingNumber: 'GIG-123456',
    });
    const hours = (new Date(shipped.autoCompleteAt) - new Date(shipped.shippedAt)) / 3_600_000;
    expect(hours).toBeCloseTo(72, 3);
  });

  test('another vendor gets 404; shipping twice is 409; missing tracking is 422', async () => {
    const { vendor, sub } = await paidSubOrder();
    const other = await signInVendor(app);
    expect((await ship(other, sub.id)).status).toBe(404);
    expect((await ship(vendor, sub.id, { courierName: 'GIG' })).status).toBe(422);
    expect((await ship(vendor, sub.id)).status).toBe(200);
    const twice = await ship(vendor, sub.id);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('INVALID_TRANSITION');
  });
});

describe('PATCH /sub-orders/:id/confirm and escrow release', () => {
  // Required test 11
  test('completing splits escrow between vendor and platform revenue, to the kobo', async () => {
    // 3 x 111,111 = 333,333 kobo; 5% = 16,666.65 -> commission 16,666, vendor 316,667.
    const { vendor, buyer, sub } = await paidSubOrder({ priceKobo: 111111, qty: 3 });
    await ship(vendor, sub.id);
    const vendorAccount = await LedgerService.openUserAccount(vendor.userId);
    const vendorBefore = vendorAccount.balanceKobo;

    const res = await confirm(buyer, sub.id);
    expect(res.status).toBe(200);
    expect(res.body.data.subOrder).toMatchObject({ status: 'COMPLETED' });

    const [escrow, revenue] = await Promise.all([
      LedgerService.getSystemAccount('PLATFORM_ESCROW'),
      LedgerService.getSystemAccount('PLATFORM_REVENUE'),
    ]);
    const entries = await releaseEntries(sub.id);
    const byAccount = Object.fromEntries(entries.map((e) => [e.account_id, e]));
    expect(byAccount[escrow.id]).toMatchObject({ direction: 'debit', amount_kobo: 333333 });
    expect(byAccount[vendorAccount.id]).toMatchObject({ direction: 'credit', amount_kobo: 316667 });
    expect(byAccount[revenue.id]).toMatchObject({ direction: 'credit', amount_kobo: 16666 });
    expect(await balanceOf(vendorAccount.id)).toBe(vendorBefore + 316667);

    const history = await postgres
      .db('order_status_history')
      .where({ sub_order_id: sub.id })
      .orderBy('id');
    expect(history.map((h) => h.to_status)).toEqual([
      'PENDING_PAYMENT',
      'PAID',
      'SHIPPED',
      'DELIVERED',
      'COMPLETED',
    ]);
  });

  test('the commission rate snapshotted at checkout is used, even if the admin changes it later', async () => {
    const { vendor, buyer, sub } = await paidSubOrder({ priceKobo: 100000 });
    const [setting] = await postgres.db('settings').where({ key: 'commission_bps' });
    await postgres
      .db('settings')
      .where({ key: 'commission_bps' })
      .update({ value: JSON.stringify(2000) });
    try {
      await ship(vendor, sub.id);
      await confirm(buyer, sub.id);
    } finally {
      await postgres
        .db('settings')
        .where({ key: 'commission_bps' })
        .update({ value: JSON.stringify(setting.value) });
    }
    const revenue = await LedgerService.getSystemAccount('PLATFORM_REVENUE');
    const entries = await releaseEntries(sub.id);
    expect(entries.find((e) => e.account_id === revenue.id).amount_kobo).toBe(5000);
  });

  // Required test 10
  test('an invalid transition is rejected: confirming a PAID sub-order, and releasing PAID -> COMPLETED', async () => {
    const { buyer, sub } = await paidSubOrder();

    const res = await confirm(buyer, sub.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { from: 'PAID', to: 'DELIVERED' },
    });

    await expect(
      postgres.withTransaction(async (trx) => {
        const locked = await ordersRepository.lockSubOrder(trx, sub.id);
        return releaseEscrow(trx, locked, { actorId: 'test', reason: 'skip ahead' });
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { from: 'PAID', to: 'COMPLETED' },
    });

    // Nothing moved: no release transaction, still PAID.
    expect(await releaseEntries(sub.id)).toHaveLength(0);
    expect((await postgres.db('sub_orders').where({ id: sub.id }).first()).status).toBe('PAID');
  });

  test('only the buyer can confirm; confirming twice releases once', async () => {
    const { vendor, buyer, sub } = await paidSubOrder();
    await ship(vendor, sub.id);
    const stranger = await signIn(app);
    expect((await confirm(stranger, sub.id)).status).toBe(404);
    expect((await confirm(vendor, sub.id)).status).toBe(404);

    const results = await Promise.all([confirm(buyer, sub.id), confirm(buyer, sub.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await releaseEntries(sub.id)).toHaveLength(3);
  });
});

test('the ledger audits clean after fulfilment', async () => {
  expect((await LedgerService.audit()).ok).toBe(true);
});
