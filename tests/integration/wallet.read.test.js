process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');
const { startFunding } = require('../helpers/wallet');

useMongo();
afterAll(() => postgres.close());

const app = createApp();

async function fundAndPay(user, amountKobo) {
  const funding = await startFunding(app, user, amountKobo);
  const pay = await request(app).post(`/mock-paystack/checkout/${funding.reference}/pay`);
  if (pay.status !== 200 || pay.body.data.webhookDeliveries.some((s) => s !== 200)) {
    throw new Error(`mock pay failed: ${pay.status} ${JSON.stringify(pay.body)}`);
  }
  return funding;
}

describe('GET /wallet', () => {
  test('a new wallet has a zero balance in kobo', async () => {
    const user = await signIn(app);
    const res = await request(app).get('/api/v1/wallet').set(user.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.wallet).toMatchObject({
      balanceKobo: 0,
      currency: 'NGN',
      status: 'ACTIVE',
    });
  });

  test('shows the balance after funding', async () => {
    const user = await signIn(app);
    await fundAndPay(user, 150000);
    await fundAndPay(user, 25000);
    const res = await request(app).get('/api/v1/wallet').set(user.auth);
    expect(res.body.data.wallet.balanceKobo).toBe(175000);
  });

  test('needs a signed-in user', async () => {
    expect((await request(app).get('/api/v1/wallet')).status).toBe(401);
  });
});

describe('GET /wallet/transactions', () => {
  test('lists the wallet ledger entries newest first, across pages, without repeats', async () => {
    const user = await signIn(app);
    const references = [];
    for (const amount of [10000, 20000, 30000]) {
      references.push((await fundAndPay(user, amount)).reference);
    }

    const items = [];
    let cursor;
    do {
      const res = await request(app)
        .get('/api/v1/wallet/transactions')
        .query({ limit: 2, ...(cursor && { cursor }) })
        .set(user.auth);
      expect(res.status).toBe(200);
      items.push(...res.body.data.items);
      cursor = res.body.data.nextCursor;
    } while (cursor);

    expect(items.map((e) => e.reference)).toEqual([...references].reverse());
    expect(items.map((e) => e.amountKobo)).toEqual([30000, 20000, 10000]);
    for (const entry of items) {
      expect(entry).toMatchObject({ type: 'FUNDING', direction: 'credit' });
    }
  });

  test("only shows the caller's own entries", async () => {
    const someoneElse = await signIn(app);
    await fundAndPay(someoneElse, 10000);
    const user = await signIn(app);
    const res = await request(app).get('/api/v1/wallet/transactions').set(user.auth);
    expect(res.body.data).toEqual({ items: [], nextCursor: null });
  });

  test('a forged cursor is a 400', async () => {
    const user = await signIn(app);
    const cursor = Buffer.from(JSON.stringify({ id: '1 OR 1=1' })).toString('base64url');
    const res = await request(app)
      .get('/api/v1/wallet/transactions')
      .query({ cursor })
      .set(user.auth);
    expect(res.status).toBe(400);
  });
});
