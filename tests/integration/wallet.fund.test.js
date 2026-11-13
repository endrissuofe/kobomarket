process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { paymentProvider } = require('../../src/integrations/payments');
const { providerError } = require('../../src/integrations/payments/errors');
const { LedgerService } = require('../../src/modules/ledger');
const { User } = require('../../src/modules/users/user.model');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
const fund = (user, body, key = randomUUID()) => {
  const req = request(app).post('/api/v1/wallet/fund').set(user.auth).send(body);
  return key ? req.set('Idempotency-Key', key) : req;
};
const fundingRow = (reference) => postgres.db('wallet_fundings').where({ reference }).first();

describe('POST /wallet/fund', () => {
  test('records an INITIATED funding and returns a checkout URL; nothing is credited yet', async () => {
    const user = await signIn(app);
    const res = await fund(user, { amountKobo: 500000 });

    expect(res.status).toBe(201);
    const { funding } = res.body.data;
    expect(funding).toMatchObject({ amountKobo: 500000, status: 'INITIATED' });
    expect(funding.reference).toMatch(/^KM-FND-/);
    expect(funding.authorizationUrl).toBe(`/mock-paystack/checkout/${funding.reference}`);

    const row = await fundingRow(funding.reference);
    expect(row).toMatchObject({ user_id: user.userId, amount_kobo: 500000, provider: 'mock' });

    const account = await LedgerService.findUserAccount(user.userId);
    expect(account.balanceKobo).toBe(0);
  });

  test('same Idempotency-Key + same body returns the same funding, not a second one', async () => {
    const user = await signIn(app);
    const key = randomUUID();
    const first = await fund(user, { amountKobo: 20000 }, key);
    const again = await fund(user, { amountKobo: 20000 }, key);
    expect(again.body).toEqual(first.body);

    const rows = await postgres.db('wallet_fundings').where({ user_id: user.userId });
    expect(rows).toHaveLength(1);
  });

  test('same key + different amount is a 409', async () => {
    const user = await signIn(app);
    const key = randomUUID();
    await fund(user, { amountKobo: 20000 }, key);
    const res = await fund(user, { amountKobo: 30000 }, key);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('the Idempotency-Key header is required', async () => {
    const user = await signIn(app);
    const res = await fund(user, { amountKobo: 20000 }, null);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  test.each([
    [{ amountKobo: 15000.5 }],
    [{ amountKobo: '20000' }],
    [{ amountKobo: 9999 }],
    [{ amountKobo: 1_000_000_001 }],
    [{}],
  ])('rejects %o with 422', async (body) => {
    const user = await signIn(app);
    expect((await fund(user, body)).status).toBe(422);
  });

  test('409 WALLET_NOT_READY while the wallet is still being opened', async () => {
    const user = await signIn(app);
    await User.updateOne({ _id: user.userId }, { $set: { walletStatus: 'PENDING' } });
    const res = await fund(user, { amountKobo: 20000 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WALLET_NOT_READY');
  });

  test('a frozen user may still fund (only orders and withdrawals are blocked)', async () => {
    const user = await signIn(app);
    await User.updateOne({ _id: user.userId }, { $set: { status: 'FROZEN' } });
    expect((await fund(user, { amountKobo: 20000 })).status).toBe(201);
  });

  test('a provider failure is a 502, the funding is marked FAILED, and the key can be retried', async () => {
    const user = await signIn(app);
    const key = randomUUID();
    const spy = jest
      .spyOn(paymentProvider, 'initialize')
      .mockRejectedValueOnce(providerError('Paystack is down'));
    try {
      const res = await fund(user, { amountKobo: 20000 }, key);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
    } finally {
      spy.mockRestore();
    }
    const [failed] = await postgres.db('wallet_fundings').where({ user_id: user.userId });
    expect(failed.status).toBe('FAILED');

    const retry = await fund(user, { amountKobo: 20000 }, key);
    expect(retry.status).toBe(201);
  });
});
