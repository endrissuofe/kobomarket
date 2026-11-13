// "Two payout requests sent at the same millisecond must not let the vendor
// withdraw more than their balance." (brief, Module H)
process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { LedgerService } = require('../../src/modules/ledger');
const { useMongo } = require('../helpers/mongo');
const { fundedVendor } = require('../helpers/vendors');
const { balanceOf } = require('../helpers/orders');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
const requestPayout = (vendor, amountKobo) =>
  request(app)
    .post('/api/v1/payouts')
    .set(vendor.auth)
    .set('Idempotency-Key', randomUUID())
    .send({ amountKobo });

test('two requests at the same moment for the whole balance: exactly one goes through', async () => {
  const vendor = await fundedVendor(app, 500000);
  const results = await Promise.all([requestPayout(vendor, 500000), requestPayout(vendor, 500000)]);

  expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  const refused = results.find((r) => r.status !== 201);
  expect(['PAYOUT_PENDING', 'INSUFFICIENT_FUNDS']).toContain(refused.body.error.code);

  expect(await balanceOf(vendor.accountId)).toBe(0);
  const payouts = await postgres.db('payouts').where({ vendor_user_id: vendor.userId });
  expect(payouts).toHaveLength(1);
}, 60_000);

test('10 requests at once for less than the balance each: one payout, never overdrawn', async () => {
  const vendor = await fundedVendor(app, 1_000_000);
  const results = await Promise.all(
    Array.from({ length: 10 }, () => requestPayout(vendor, 300000)),
  );

  expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  for (const r of results.filter((x) => x.status !== 201)) {
    expect(r.body.error.code).toBe('PAYOUT_PENDING');
  }
  expect(await balanceOf(vendor.accountId)).toBe(700000);
  expect(await postgres.db('payouts').where({ vendor_user_id: vendor.userId })).toHaveLength(1);
}, 120_000);

test('the ledger audits clean after the payout races', async () => {
  expect((await LedgerService.audit()).ok).toBe(true);
});
