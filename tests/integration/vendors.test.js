process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { User } = require('../../src/modules/users/user.model');
const { Vendor } = require('../../src/modules/vendors/vendor.model');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');

useMongo();
afterAll(() => postgres.close());

const app = createApp();

const application = (overrides = {}) => ({
  storeName: `Ada Fabrics ${randomUUID().slice(0, 8)}`,
  description: 'Ankara and lace',
  bank: { bankCode: '058', accountNumber: '0123456789', accountName: 'Ada Lovelace' },
  ...overrides,
});
const apply = (user, body = application()) =>
  request(app).post('/api/v1/vendors/apply').set(user.auth).send(body);

describe('POST /vendors/apply', () => {
  test('creates a PENDING store with a slug and masked bank details', async () => {
    const user = await signIn(app);
    const body = application();
    const res = await apply(user, body);

    expect(res.status).toBe(201);
    const { vendor } = res.body.data;
    expect(vendor).toMatchObject({
      storeName: body.storeName,
      status: 'PENDING',
      userId: user.userId,
      bank: { bankCode: '058', accountNumber: '******6789', accountName: 'Ada Lovelace' },
    });
    expect(vendor.slug).toMatch(/^ada-fabrics-[a-f0-9]{8}$/);

    // Applying is not approval: still a buyer only.
    expect((await User.findById(user.userId)).roles).toEqual(['buyer']);
  });

  test('a second application while pending is refused with 409', async () => {
    const user = await signIn(app);
    await apply(user);
    const res = await apply(user);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_APPLIED');
  });

  test('two stores with the same name get different slugs', async () => {
    const storeName = `Same Name ${randomUUID().slice(0, 8)}`;
    const a = await apply(await signIn(app), application({ storeName }));
    const b = await apply(await signIn(app), application({ storeName }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.data.vendor.slug).not.toBe(a.body.data.vendor.slug);
    expect(b.body.data.vendor.slug.startsWith(a.body.data.vendor.slug)).toBe(true);
  });

  test('a frozen user cannot apply', async () => {
    const user = await signIn(app);
    await User.updateOne({ _id: user.userId }, { $set: { status: 'FROZEN' } });
    const res = await apply(user);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_FROZEN');
  });

  test('bad bank details are rejected with field errors', async () => {
    const user = await signIn(app);
    const res = await apply(
      user,
      application({ bank: { bankCode: 'GTB', accountNumber: '123', accountName: 'A' } }),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.details).toHaveProperty('bank');
  });

  test('requires a signed-in user', async () => {
    const res = await request(app).post('/api/v1/vendors/apply').send(application());
    expect(res.status).toBe(401);
  });
});

describe('GET /vendors/me and GET /vendors/:id', () => {
  test('the applicant sees their own application; the public cannot see a pending store', async () => {
    const user = await signIn(app);
    const { vendor } = (await apply(user)).body.data;

    const mine = await request(app).get('/api/v1/vendors/me').set(user.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.data.vendor).toMatchObject({ id: vendor.id, status: 'PENDING' });

    const pub = await request(app).get(`/api/v1/vendors/${vendor.id}`);
    expect(pub.status).toBe(404);
  });

  test('an approved store is public, without bank details or status internals', async () => {
    const user = await signIn(app);
    const { vendor } = (await apply(user)).body.data;
    await Vendor.updateOne({ _id: vendor.id }, { $set: { status: 'APPROVED' } });

    const res = await request(app).get(`/api/v1/vendors/${vendor.id}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data.vendor).sort()).toEqual(
      ['createdAt', 'description', 'id', 'slug', 'storeName'].sort(),
    );
  });

  test('GET /vendors/me is 404 for someone who never applied', async () => {
    const user = await signIn(app);
    expect((await request(app).get('/api/v1/vendors/me').set(user.auth)).status).toBe(404);
  });

  test('a malformed id is a 422, not a crash', async () => {
    expect((await request(app).get('/api/v1/vendors/not-an-id')).status).toBe(422);
  });
});
