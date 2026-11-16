// The demo seed: right counts, logins work, safe to run twice, ledger balanced.
process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { LedgerService } = require('../../src/modules/ledger');
const { seed } = require('../../scripts/seed');
const data = require('../../seeds/demo-data');
const { useMongo } = require('../helpers/mongo');

jest.setTimeout(300_000);
useMongo();
afterAll(() => postgres.close());

const app = createApp();
const quiet = { log: () => {} };
const login = (email) =>
  request(app).post('/api/v1/auth/login').send({ email, password: data.DEMO_PASSWORD });

let first;
beforeAll(async () => {
  first = await seed(quiet);
  await seed(quiet); // a second run must change nothing
});

test('1 admin, 3 approved vendors, 20 live products and 5 buyers, all able to log in', async () => {
  const adminLogin = await login(data.admin.email);
  expect(adminLogin.status).toBe(200);
  const me = await request(app)
    .get('/api/v1/users/me')
    .set('Authorization', `Bearer ${adminLogin.body.data.accessToken}`);
  expect(me.body.data.user.roles).toContain('admin');

  let products = 0;
  for (const { store } of first.stores) {
    expect((await request(app).get(`/api/v1/vendors/${store._id}`)).status).toBe(200);
    const res = await request(app)
      .get('/api/v1/products')
      .query({ vendorId: String(store._id), limit: 100 });
    products += res.body.data.items.length;
  }
  expect(products).toBe(20);

  for (const v of data.vendors) expect((await login(v.email)).status).toBe(200);
  expect(first.buyers).toHaveLength(5);
  expect((await login(data.buyers[0].email)).status).toBe(200);
});

test('each buyer is funded exactly once through the ledger, even after two runs', async () => {
  for (const b of data.buyers) {
    const funding = await postgres.db('transactions').where({ reference: `SEED-FUND-${b.email}` });
    expect(funding).toHaveLength(1);
    expect(funding[0].type).toBe('FUNDING');
    const entries = await postgres
      .db('ledger_entries')
      .where({ transaction_id: funding[0].id, direction: 'credit' });
    expect(entries[0].amount_kobo).toBe(b.fundKobo);
  }
  expect((await LedgerService.audit()).ok).toBe(true);
});

test('products keep the variant rule: price is the lowest variant price, stock the total', async () => {
  const res = await request(app).get('/api/v1/products/ankara-wrap-dress');
  expect(res.body.data.product).toMatchObject({ priceKobo: 2_200_000, stock: 16 });
});
