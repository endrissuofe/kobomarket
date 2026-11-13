// Required test 3: a buyer cannot access vendor or admin routes.
// Every guarded route is listed here; add new vendor/admin routes as they land.
process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
const ANY_ID = '0123456789abcdef01234567';

// Every row has three values. With fewer, Jest's test.each would pass its
// `done` callback as the missing argument and wait for it forever.
const ADMIN_ROUTES = [
  ['get', '/api/v1/admin/vendors', undefined],
  ['patch', `/api/v1/admin/vendors/${ANY_ID}/approve`, undefined],
  ['patch', `/api/v1/admin/vendors/${ANY_ID}/reject`, { reason: 'not allowed anyway' }],
];

// Vendor-only routes arrive with products (step 4): POST/PATCH/DELETE /products.
const VENDOR_ROUTES = [];

function call([method, path, body], headers = {}) {
  const req = request(app)[method](path).set(headers);
  return body === undefined ? req : req.send(body);
}

let buyer;
let vendor;
beforeAll(async () => {
  buyer = await signIn(app);
  vendor = await signIn(app, { roles: ['buyer', 'vendor'] });
});

describe('RBAC', () => {
  test.each([...ADMIN_ROUTES, ...VENDOR_ROUTES])(
    'a buyer gets 403 on %s %s',
    async (method, path, body) => {
      const res = await call([method, path, body], buyer.auth);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'FORBIDDEN', message: expect.any(String) },
      });
    },
  );

  test.each(ADMIN_ROUTES)('a vendor gets 403 on admin route %s %s', async (method, path, body) => {
    expect((await call([method, path, body], vendor.auth)).status).toBe(403);
  });

  test.each([...ADMIN_ROUTES, ...VENDOR_ROUTES])(
    'no token gets 401 on %s %s',
    async (method, path, body) => {
      expect((await call([method, path, body])).status).toBe(401);
    },
  );

  test('the role guard runs before validation, so a buyer learns nothing from a bad body', async () => {
    const res = await call(['patch', `/api/v1/admin/vendors/${ANY_ID}/reject`, {}], buyer.auth);
    expect(res.status).toBe(403);
  });
});
