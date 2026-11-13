process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { paymentProvider, sign } = require('../../src/integrations/payments');
const { providerError } = require('../../src/integrations/payments/errors');
const { LedgerService } = require('../../src/modules/ledger');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');
const { startFunding, paidWebhook, sendWebhook } = require('../helpers/wallet');

useMongo();
afterAll(() => postgres.close());

const app = createApp();

const balanceOf = async (user) => (await LedgerService.findUserAccount(user.userId)).balanceKobo;
const fundingTransactions = (reference) =>
  postgres.db('transactions').where({ reference, type: 'FUNDING' });
const fundingRow = (reference) => postgres.db('wallet_fundings').where({ reference }).first();

describe('Paystack webhook: crediting', () => {
  test('paying on the mock checkout sends the webhook twice; the wallet is credited once', async () => {
    const user = await signIn(app);
    const funding = await startFunding(app, user, 750000);

    const pay = await request(app).post(`/mock-paystack/checkout/${funding.reference}/pay`);
    expect(pay.status).toBe(200);
    expect(pay.body.data.webhookDeliveries).toEqual([200, 200]);

    expect(await balanceOf(user)).toBe(750000);
    expect(await fundingTransactions(funding.reference)).toHaveLength(1);
    expect(await fundingRow(funding.reference)).toMatchObject({ status: 'SUCCESS' });
  });

  // Required test 4
  test('the same webhook sent twice credits the wallet once', async () => {
    const user = await signIn(app);
    const funding = await startFunding(app, user, 300000);
    const webhook = await paidWebhook(funding.reference);

    const first = await sendWebhook(app, webhook);
    const second = await sendWebhook(app, webhook);
    expect(first.body.data.outcome).toBe('credited');
    expect(second.status).toBe(200);
    expect(second.body.data.outcome).toBe('duplicate');

    expect(await balanceOf(user)).toBe(300000);
    expect(await fundingTransactions(funding.reference)).toHaveLength(1);
  });

  test('the same webhook sent 5 times at once still credits once', async () => {
    const user = await signIn(app);
    const funding = await startFunding(app, user, 120000);
    const webhook = await paidWebhook(funding.reference);

    const results = await Promise.all(Array.from({ length: 5 }, () => sendWebhook(app, webhook)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(results.filter((r) => r.body.data.outcome === 'credited')).toHaveLength(1);

    expect(await balanceOf(user)).toBe(120000);
    expect(await fundingTransactions(funding.reference)).toHaveLength(1);
  });

  test('if the first delivery fails mid-way, the redelivery credits', async () => {
    const user = await signIn(app);
    const funding = await startFunding(app, user, 50000);
    const webhook = await paidWebhook(funding.reference);

    const spy = jest
      .spyOn(paymentProvider, 'verify')
      .mockRejectedValueOnce(providerError('Paystack timed out'));
    try {
      expect((await sendWebhook(app, webhook)).status).toBe(502);
    } finally {
      spy.mockRestore();
    }
    expect(await balanceOf(user)).toBe(0);

    const retry = await sendWebhook(app, webhook);
    expect(retry.body.data.outcome).toBe('credited');
    expect(await balanceOf(user)).toBe(50000);
  });

  test('if verify reports a different amount, nothing is credited and the funding fails', async () => {
    const user = await signIn(app);
    const funding = await startFunding(app, user, 400000);
    const webhook = await paidWebhook(funding.reference);
    paymentProvider.tamper(funding.reference, { amountKobo: 4000 });

    const res = await sendWebhook(app, webhook);
    expect(res.body.data.outcome).toBe('amount_mismatch');
    expect(await balanceOf(user)).toBe(0);
    expect(await fundingRow(funding.reference)).toMatchObject({ status: 'FAILED' });
  });

  test('the amount in the webhook body is never trusted', async () => {
    const user = await signIn(app);
    const funding = await startFunding(app, user, 10000);
    await paidWebhook(funding.reference);
    // A correctly signed body claiming a bigger amount (e.g. a leaked secret).
    const event = JSON.parse(paymentProvider.chargeSuccessEvent(funding.reference));
    event.data.amount = 99_999_999;
    const body = JSON.stringify(event);
    const { paystackSecret } = require('../../src/config').payments;

    await sendWebhook(app, { body, signature: sign(body, paystackSecret) });
    expect(await balanceOf(user)).toBe(10000);
  });

  test('a payment that is not successful at verify is not credited', async () => {
    const user = await signIn(app);
    const funding = await startFunding(app, user, 20000);
    const webhook = await paidWebhook(funding.reference);
    paymentProvider.tamper(funding.reference, { status: 'abandoned' });

    const res = await sendWebhook(app, webhook);
    expect(res.body.data.outcome).toBe('not_paid:abandoned');
    expect(await balanceOf(user)).toBe(0);
  });

  test('unknown references and other event types are acknowledged and ignored', async () => {
    const { paystackSecret } = require('../../src/config').payments;
    const unknown = JSON.stringify({
      event: 'charge.success',
      data: { id: Date.now(), reference: 'NOT-OURS-1', amount: 100, currency: 'NGN' },
    });
    const other = JSON.stringify({ event: 'transfer.success', data: { id: Date.now() + 1 } });

    const a = await sendWebhook(app, { body: unknown, signature: sign(unknown, paystackSecret) });
    const b = await sendWebhook(app, { body: other, signature: sign(other, paystackSecret) });
    expect(a.body.data.outcome).toBe('unknown_reference');
    expect(b.body.data.outcome).toBe('ignored');
  });
});

describe('Paystack webhook: signatures', () => {
  // Required test 5
  test('a webhook with an invalid signature is rejected and credits nothing', async () => {
    const user = await signIn(app);
    const funding = await startFunding(app, user, 250000);
    const { body } = await paidWebhook(funding.reference);

    const forged = await sendWebhook(app, { body, signature: sign(body, 'sk_test_attacker') });
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('INVALID_SIGNATURE');

    expect(await balanceOf(user)).toBe(0);
    expect(await fundingRow(funding.reference)).toMatchObject({ status: 'INITIATED' });
    const logged = await postgres
      .db('webhook_events')
      .whereRaw("payload->'data'->>'reference' = ?", [funding.reference]);
    expect(logged).toHaveLength(0);
  });

  test('an unsigned webhook is rejected', async () => {
    const user = await signIn(app);
    const funding = await startFunding(app, user, 250000);
    const { body } = await paidWebhook(funding.reference);

    const res = await sendWebhook(app, { body, signature: undefined });
    expect(res.status).toBe(401);
    expect(await balanceOf(user)).toBe(0);
  });

  test('a body changed after signing is rejected', async () => {
    const user = await signIn(app);
    const funding = await startFunding(app, user, 250000);
    const { body, signature } = await paidWebhook(funding.reference);

    const res = await sendWebhook(app, { body: body.replace('250000', '250001'), signature });
    expect(res.status).toBe(401);
  });
});

test('the ledger still audits clean after the webhook tests', async () => {
  expect((await LedgerService.audit()).ok).toBe(true);
});
