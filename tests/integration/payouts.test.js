process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { LedgerService } = require('../../src/modules/ledger');
const { User } = require('../../src/modules/users/user.model');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');
const { fundedVendor } = require('../helpers/vendors');
const { balanceOf } = require('../helpers/orders');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
const requestPayout = (vendor, amountKobo, key = randomUUID()) =>
  request(app)
    .post('/api/v1/payouts')
    .set(vendor.auth)
    .set('Idempotency-Key', key)
    .send({ amountKobo });

describe('POST /payouts', () => {
  test('moves the money to payout clearing at once and creates a PENDING payout', async () => {
    const vendor = await fundedVendor(app, 500000);
    const res = await requestPayout(vendor, 300000);
    expect(res.status).toBe(201);
    expect(res.body.data.payout).toMatchObject({
      amountKobo: 300000,
      status: 'PENDING',
      bank: { bankCode: '058', accountNumber: '******6789', accountName: 'Test Vendor' },
    });
    expect(await balanceOf(vendor.accountId)).toBe(200000);
    const hold = await postgres
      .db('transactions')
      .where({ reference: `PAY-${res.body.data.payout.id}-HOLD` })
      .first();
    expect(hold.type).toBe('PAYOUT_HOLD');
  });

  test('below the minimum (NGN 1,000 = 100,000 kobo) is a 422', async () => {
    const vendor = await fundedVendor(app, 500000);
    const res = await requestPayout(vendor, 99999);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'BELOW_PAYOUT_MINIMUM',
      details: { minimumKobo: 100000 },
    });
    expect(await balanceOf(vendor.accountId)).toBe(500000);
  });

  test('more than the balance is refused and nothing moves', async () => {
    const vendor = await fundedVendor(app, 150000);
    const res = await requestPayout(vendor, 150001);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await postgres.db('payouts').where({ vendor_user_id: vendor.userId })).toHaveLength(0);
  });

  test('only one PENDING payout at a time', async () => {
    const vendor = await fundedVendor(app, 1_000_000);
    await requestPayout(vendor, 200000);
    const res = await requestPayout(vendor, 200000);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYOUT_PENDING');
    expect(await balanceOf(vendor.accountId)).toBe(800000);
  });

  test('the same Idempotency-Key replays the payout instead of making another', async () => {
    const vendor = await fundedVendor(app, 1_000_000);
    const key = randomUUID();
    const first = await requestPayout(vendor, 200000, key);
    const again = await requestPayout(vendor, 200000, key);
    expect(again.body.data.payout.id).toBe(first.body.data.payout.id);
    expect(await balanceOf(vendor.accountId)).toBe(800000);
  });

  test('a frozen vendor cannot withdraw; a buyer cannot reach payouts', async () => {
    const vendor = await fundedVendor(app, 500000);
    await User.updateOne({ _id: vendor.userId }, { $set: { status: 'FROZEN' } });
    const res = await requestPayout(vendor, 200000);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_FROZEN');

    const buyer = await signIn(app);
    expect((await requestPayout(buyer, 200000)).status).toBe(403);
  });

  test('a decimal or string amount is a 422', async () => {
    const vendor = await fundedVendor(app, 500000);
    expect((await requestPayout(vendor, 150000.5)).status).toBe(422);
    expect((await requestPayout(vendor, '150000')).status).toBe(422);
  });
});

describe('GET /payouts', () => {
  test("lists the vendor's own payouts, newest first", async () => {
    const vendor = await fundedVendor(app, 500000);
    const created = (await requestPayout(vendor, 150000)).body.data.payout;
    const res = await request(app).get('/api/v1/payouts').set(vendor.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((p) => p.id)).toEqual([created.id]);
    expect(res.body.data.items[0]).not.toHaveProperty('accountId');
  });
});

test('the ledger audits clean after payout requests', async () => {
  expect((await LedgerService.audit()).ok).toBe(true);
});
