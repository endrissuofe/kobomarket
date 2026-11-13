// Required test 14 and the rest of the payout processor.
process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { LedgerService } = require('../../src/modules/ledger');
const { paymentProvider } = require('../../src/integrations/payments');
const { providerError } = require('../../src/integrations/payments/errors');
const { runPayoutProcessor } = require('../../src/jobs/payout-processor');
const { useMongo } = require('../helpers/mongo');
const { fundedVendor } = require('../helpers/vendors');
const { balanceOf } = require('../helpers/orders');

useMongo();
afterAll(() => postgres.close());

const app = createApp();

// Other test files leave PENDING payouts behind (locally no worker runs).
// Process them first so each test here only waits on its own payout.
beforeAll(async () => {
  for (let i = 0; i < 100; i += 1) {
    const r = await runPayoutProcessor({ batchSize: 100 });
    if (r.settled + r.reversed + r.pending + r.errors === 0) break;
  }
}, 300_000);

async function pendingPayout({ balance = 500000, amount = 300000, accountNumber } = {}) {
  const vendor = await fundedVendor(app, balance, accountNumber && { accountNumber });
  const res = await request(app)
    .post('/api/v1/payouts')
    .set(vendor.auth)
    .set('Idempotency-Key', randomUUID())
    .send({ amountKobo: amount });
  expect(res.status).toBe(201);
  return { vendor, payout: res.body.data.payout };
}
const payoutRow = (id) => postgres.db('payouts').where({ id }).first();
const txn = (reference) => postgres.db('transactions').where({ reference }).first();

describe('payout processor', () => {
  test('a successful transfer clears payout clearing and marks the payout SUCCESS', async () => {
    const { vendor, payout } = await pendingPayout();
    await runPayoutProcessor({ batchSize: 100 });

    const row = await payoutRow(payout.id);
    expect(row).toMatchObject({ status: 'SUCCESS', failure_reason: null });
    expect(row.provider_ref).toMatch(/^TRF_mock_/);
    expect((await txn(`PAY-${payout.id}-SETTLE`)).type).toBe('PAYOUT_SETTLE');
    expect(await balanceOf(vendor.accountId)).toBe(200000);

    const res = await request(app).get('/api/v1/payouts').set(vendor.auth);
    expect(res.body.data.items[0]).toMatchObject({ id: payout.id, status: 'SUCCESS' });
  });

  // Required test 14
  test('a failed payout returns the money to the vendor wallet', async () => {
    const { vendor, payout } = await pendingPayout({ accountNumber: '0123450000' });
    expect(await balanceOf(vendor.accountId)).toBe(200000);

    await runPayoutProcessor({ batchSize: 100 });

    const row = await payoutRow(payout.id);
    expect(row).toMatchObject({ status: 'FAILED' });
    expect(row.failure_reason).toContain('0000');
    expect((await txn(`PAY-${payout.id}-REV`)).type).toBe('PAYOUT_REVERSAL');
    expect(await balanceOf(vendor.accountId)).toBe(500000);

    // The hold and the reversal cancel out in payout clearing.
    const clearing = await LedgerService.getSystemAccount('PLATFORM_PAYOUT_CLEARING');
    const moves = await postgres
      .db('ledger_entries as e')
      .join('transactions as t', 't.id', 'e.transaction_id')
      .where('e.account_id', clearing.id)
      .whereIn('t.reference', [`PAY-${payout.id}-HOLD`, `PAY-${payout.id}-REV`])
      .select('e.direction', 'e.amount_kobo');
    const net = moves.reduce(
      (s, m) => s + (m.direction === 'credit' ? m.amount_kobo : -m.amount_kobo),
      0,
    );
    expect(net).toBe(0);

    // With the failed one finished, the vendor can request again.
    const again = await request(app)
      .post('/api/v1/payouts')
      .set(vendor.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ amountKobo: 100000 });
    expect(again.status).toBe(201);
  });

  test('two processor runs at once settle the payout once', async () => {
    const { payout } = await pendingPayout();
    await Promise.all([
      runPayoutProcessor({ batchSize: 100 }),
      runPayoutProcessor({ batchSize: 100 }),
    ]);
    expect((await payoutRow(payout.id)).status).toBe('SUCCESS');
    const settles = await postgres
      .db('transactions')
      .where({ reference: `PAY-${payout.id}-SETTLE` });
    expect(settles).toHaveLength(1);
  });

  test('a provider still processing leaves the payout PENDING to check later', async () => {
    const { payout } = await pendingPayout();
    const spy = jest
      .spyOn(paymentProvider, 'transfer')
      .mockResolvedValue({ status: 'pending', providerRef: 'TRF_slow', reason: null });
    try {
      await runPayoutProcessor({ batchSize: 100 });
    } finally {
      spy.mockRestore();
    }
    const row = await payoutRow(payout.id);
    expect(row).toMatchObject({ status: 'PENDING', provider_ref: 'TRF_slow' });
    expect(new Date(row.claimed_until).getTime()).toBeGreaterThan(Date.now());
  });

  test('a provider error never reverses: the payout stays PENDING for a retry', async () => {
    const { vendor, payout } = await pendingPayout();
    const spy = jest
      .spyOn(paymentProvider, 'transfer')
      .mockRejectedValue(providerError('Paystack timed out'));
    try {
      await runPayoutProcessor({ batchSize: 100 });
    } finally {
      spy.mockRestore();
    }
    expect((await payoutRow(payout.id)).status).toBe('PENDING');
    expect(await balanceOf(vendor.accountId)).toBe(200000);

    // Once the lease runs out it is retried and settles.
    await postgres.db('payouts').where({ id: payout.id }).update({ claimed_until: null });
    await runPayoutProcessor({ batchSize: 100 });
    expect((await payoutRow(payout.id)).status).toBe('SUCCESS');
  });

  test('the ledger audits clean after processing payouts', async () => {
    expect((await LedgerService.audit()).ok).toBe(true);
  });
});
