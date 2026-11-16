process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { LedgerService, SYSTEM_ACCOUNTS, TRANSACTION_TYPES } = require('../../src/modules/ledger');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');
const { fundedVendor } = require('../helpers/vendors');
const { makeProduct } = require('../helpers/products');
const { fundedBuyer, addToCart, checkout } = require('../helpers/orders');

jest.setTimeout(120_000);
useMongo();
afterAll(() => postgres.close());

const app = createApp();
let admin;
beforeAll(async () => {
  admin = await signIn(app, { roles: ['buyer', 'admin'] });
});
const as = (who) => (method, path) => request(app)[method](`/api/v1/admin${path}`).set(who.auth);
const adminCall = (method, path) => as(admin)(method, path);

describe('users: list, search, freeze', () => {
  test('search by email prefix, filter by role, paginate', async () => {
    const tag = `srch${randomUUID().slice(0, 8)}`;
    const made = [];
    for (let i = 0; i < 3; i += 1) {
      const { email } = await signIn(app, {});
      const { User } = require('../../src/modules/users/user.model');
      await User.updateOne({ email }, { $set: { email: `${tag}-${i}@test.kobomarket.dev` } });
      made.push(`${tag}-${i}@test.kobomarket.dev`);
    }
    const seen = [];
    let cursor;
    do {
      const res = await adminCall('get', '/users').query({
        q: tag,
        limit: 2,
        ...(cursor && { cursor }),
      });
      expect(res.status).toBe(200);
      seen.push(...res.body.data.items.map((u) => u.email));
      cursor = res.body.data.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...made].reverse());

    // Make sure at least one vendor exists, even on a fresh database.
    const vendor = await fundedVendor(app, 0);
    const vendors = await adminCall('get', '/users').query({ role: 'vendor', limit: 5 });
    const items = vendors.body.data.items;
    expect(items.map((u) => u.id)).toContain(vendor.userId);
    expect(items.every((u) => u.roles.includes('vendor'))).toBe(true);
    expect(items[0]).not.toHaveProperty('passwordHash');
  });

  test('search text is matched literally, not as a regex', async () => {
    const res = await adminCall('get', '/users').query({ q: '.*' });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  test('a frozen user cannot order or withdraw, and the ledger refuses their debits; unfreeze restores it', async () => {
    const buyer = await fundedBuyer(app, 500000);
    const vendor = await fundedVendor(app, 500000);
    const product = await makeProduct(app, vendor);
    await addToCart(app, buyer, product.id, 1);

    for (const who of [buyer, vendor]) {
      const res = await adminCall('patch', `/users/${who.userId}/freeze`).send({
        reason: 'Suspicious activity',
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        user: { status: 'FROZEN', frozenReason: 'Suspicious activity', frozenBy: admin.userId },
        walletStatus: 'FROZEN',
      });
    }

    expect((await checkout(app, buyer)).body.error.code).toBe('ACCOUNT_FROZEN');
    const payout = await request(app)
      .post('/api/v1/payouts')
      .set(vendor.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ amountKobo: 200000 });
    expect(payout.body.error.code).toBe('ACCOUNT_FROZEN');

    // Even a direct ledger debit is refused: the freeze is in Postgres too.
    const escrow = await LedgerService.getSystemAccount(SYSTEM_ACCOUNTS.PLATFORM_ESCROW);
    await expect(
      LedgerService.post({
        reference: `FROZEN-${randomUUID()}`,
        type: TRANSACTION_TYPES.ESCROW_HOLD,
        entries: [
          { accountId: buyer.accountId, direction: 'debit', amountKobo: 100 },
          { accountId: escrow.id, direction: 'credit', amountKobo: 100 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_FROZEN' });

    const un = await adminCall('patch', `/users/${buyer.userId}/unfreeze`);
    expect(un.body.data).toMatchObject({
      user: { status: 'ACTIVE', frozenReason: null },
      walletStatus: 'ACTIVE',
    });
    expect((await checkout(app, buyer)).status).toBe(201);
  });

  test('admins cannot freeze themselves; a reason is required; unknown user is 404', async () => {
    expect(
      (await adminCall('patch', `/users/${admin.userId}/freeze`).send({ reason: 'testing self' }))
        .body.error.code,
    ).toBe('CANNOT_FREEZE_SELF');
    const someone = await signIn(app);
    expect((await adminCall('patch', `/users/${someone.userId}/freeze`).send({})).status).toBe(422);
    expect(
      (
        await adminCall('patch', '/users/0123456789abcdef01234567/freeze').send({
          reason: 'not here',
        })
      ).status,
    ).toBe(404);
  });
});

describe('wallets and transactions', () => {
  test("any wallet's full ledger history, newest first", async () => {
    const buyer = await fundedBuyer(app, 300000);
    const vendor = await fundedVendor(app, 0);
    await addToCart(app, buyer, (await makeProduct(app, vendor, { priceKobo: 100000 })).id, 1);
    await checkout(app, buyer);

    const res = await adminCall('get', `/wallets/${buyer.accountId}/ledger`).query({ limit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.data.account).toMatchObject({ id: buyer.accountId, balanceKobo: 200000 });
    expect(res.body.data.items[0]).toMatchObject({
      type: 'ESCROW_HOLD',
      direction: 'debit',
      amountKobo: 100000,
    });
    const next = await adminCall('get', `/wallets/${buyer.accountId}/ledger`).query({
      cursor: res.body.data.nextCursor,
    });
    expect(next.body.data.items[0]).toMatchObject({
      type: 'FUNDING',
      direction: 'credit',
      amountKobo: 300000,
    });

    const escrow = await LedgerService.getSystemAccount('PLATFORM_ESCROW');
    expect((await adminCall('get', `/wallets/${escrow.id}/ledger`)).status).toBe(200);
    expect((await adminCall('get', `/wallets/${randomUUID()}/ledger`)).status).toBe(404);
  });

  test('all transactions, filterable by type or reference, each with its entries', async () => {
    const buyer = await fundedBuyer(app, 300000);
    const vendor = await fundedVendor(app, 0);
    await addToCart(app, buyer, (await makeProduct(app, vendor, { priceKobo: 100000 })).id, 1);
    const order = (await checkout(app, buyer)).body.data.order;

    const one = await adminCall('get', '/transactions').query({ reference: `ORD-${order.id}` });
    expect(one.body.data.items).toHaveLength(1);
    const txn = one.body.data.items[0];
    expect(txn).toMatchObject({ type: 'ESCROW_HOLD' });
    expect(txn.entries).toHaveLength(2);

    // At least this file's own two escrow holds exist, so limit 1 must page.
    const holds = await adminCall('get', '/transactions').query({ type: 'ESCROW_HOLD', limit: 1 });
    expect(holds.body.data.items).toHaveLength(1);
    expect(holds.body.data.items[0].type).toBe('ESCROW_HOLD');
    const next = await adminCall('get', '/transactions').query({
      type: 'ESCROW_HOLD',
      limit: 1,
      cursor: holds.body.data.nextCursor,
    });
    expect(next.body.data.items[0].type).toBe('ESCROW_HOLD');
    expect(next.body.data.items[0].id).not.toBe(holds.body.data.items[0].id);
  });
});

describe('settings: commission', () => {
  test('a new rate applies to new checkouts only', async () => {
    const before = (await adminCall('get', '/settings')).body.data.settings.commissionBps;
    const vendor = await fundedVendor(app, 0);
    const product = await makeProduct(app, vendor, { priceKobo: 100000, stock: 10 });
    const early = await fundedBuyer(app, 500000);
    await addToCart(app, early, product.id, 1);
    const earlySub = (await checkout(app, early)).body.data.order.subOrders[0];

    try {
      const res = await adminCall('patch', '/settings/commission').send({ commissionBps: 750 });
      expect(res.body.data.settings.commissionBps).toBe(750);
      const late = await fundedBuyer(app, 500000);
      await addToCart(app, late, product.id, 1);
      const lateSub = (await checkout(app, late)).body.data.order.subOrders[0];
      expect(lateSub.commissionBps).toBe(750);
      expect(earlySub.commissionBps).toBe(before);
    } finally {
      await adminCall('patch', '/settings/commission').send({ commissionBps: before });
    }
  });

  test.each([[{ commissionBps: 7.5 }], [{ commissionBps: -1 }], [{ commissionBps: 6000 }], [{}]])(
    'rejects %o',
    async (body) => {
      expect((await adminCall('patch', '/settings/commission').send(body)).status).toBe(422);
    },
  );
});

describe('reports', () => {
  const lagosToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

  /** A completed sale of priceKobo for a fresh vendor; returns the vendor. */
  async function completedSale(priceKobo) {
    const vendor = await fundedVendor(app, 0);
    const buyer = await fundedBuyer(app, priceKobo + 100000);
    await addToCart(app, buyer, (await makeProduct(app, vendor, { priceKobo })).id, 1);
    const sub = (await checkout(app, buyer)).body.data.order.subOrders[0];
    await request(app)
      .patch(`/api/v1/sub-orders/${sub.id}/ship`)
      .set(vendor.auth)
      .send({ courierName: 'GIG', trackingNumber: 'T-1' });
    await request(app).patch(`/api/v1/sub-orders/${sub.id}/confirm`).set(buyer.auth);
    return vendor;
  }

  test('revenue per day: every day in the range, today grows by the commission', async () => {
    const today = lagosToday();
    const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);
    const read = async () =>
      (await adminCall('get', '/reports/revenue').query({ from: yesterday, to: today })).body.data;

    const before = await read();
    expect(before.days.map((d) => d.day)).toEqual([yesterday, today]);
    await completedSale(200000); // 5% commission = 10,000 kobo
    const after = await read();
    expect(after.days[1].revenueKobo - before.days[1].revenueKobo).toBe(10000);
    expect(after.totalKobo).toBe(after.days[0].revenueKobo + after.days[1].revenueKobo);
  });

  test('revenue: bad ranges are 422', async () => {
    for (const q of [
      { from: '2026-11-10', to: '2026-11-01' },
      { from: '2025-01-01', to: '2026-11-01' },
      { from: '11/01/2026', to: '2026-11-02' },
    ]) {
      expect((await adminCall('get', '/reports/revenue').query(q)).status).toBe(422);
    }
  });

  test('top vendors this month, by completed sales, with store names', async () => {
    // Above any other test's sale, and above this test's own earlier runs this
    // month (the local test database is shared): the amount grows with time.
    const amount = 90_000_000 + (Math.floor(Date.now() / 1000) % 10_000_000);
    const big = await completedSale(amount);
    const res = await adminCall('get', '/reports/top-vendors');
    expect(res.status).toBe(200);
    const { vendors } = res.body.data;
    expect(vendors.length).toBeLessThanOrEqual(10);
    expect(vendors[0]).toMatchObject({
      rank: 1,
      vendorId: big.vendorId,
      salesKobo: amount,
      completedSubOrders: 1,
    });
    expect(vendors[0].storeName).toMatch(/^Test Store/);
    for (let i = 1; i < vendors.length; i += 1) {
      expect(vendors[i - 1].salesKobo).toBeGreaterThanOrEqual(vendors[i].salesKobo);
    }
  });

  test('escrow: a checkout raises the escrow balance and the open sub-orders by the same amount', async () => {
    const read = async () => (await adminCall('get', '/reports/escrow')).body.data;
    const before = await read();
    const buyer = await fundedBuyer(app, 500000);
    const vendor = await fundedVendor(app, 0);
    await addToCart(app, buyer, (await makeProduct(app, vendor, { priceKobo: 123400 })).id, 1);
    await checkout(app, buyer);
    const after = await read();
    expect(after.escrowBalanceKobo - before.escrowBalanceKobo).toBe(123400);
    expect(after.openSubOrders.totalKobo - before.openSubOrders.totalKobo).toBe(123400);
  });

  test('reconciliation: no wallet differs from its ledger', async () => {
    const res = await adminCall('get', '/reports/reconciliation');
    expect(res.body.data).toEqual({ ok: true, mismatches: [] });
  });
});
