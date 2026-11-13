process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
let admin;
beforeAll(async () => {
  admin = await signIn(app, { roles: ['buyer', 'admin'] });
});

async function applicant() {
  const user = await signIn(app);
  const res = await request(app)
    .post('/api/v1/vendors/apply')
    .set(user.auth)
    .send({
      storeName: `Store ${randomUUID().slice(0, 8)}`,
      bank: { bankCode: '058', accountNumber: '0123456789', accountName: 'Test Vendor' },
    });
  return { user, vendor: res.body.data.vendor };
}
const approve = (id, who = admin) =>
  request(app).patch(`/api/v1/admin/vendors/${id}/approve`).set(who.auth);
const reject = (id, reason = 'Bank account name does not match', who = admin) =>
  request(app).patch(`/api/v1/admin/vendors/${id}/reject`).set(who.auth).send({ reason });

describe('PATCH /admin/vendors/:id/approve', () => {
  test('approves, records the review time, and the existing access token gains the vendor role', async () => {
    const { user, vendor } = await applicant();

    const res = await approve(vendor.id);
    expect(res.status).toBe(200);
    expect(res.body.data.vendor).toMatchObject({ status: 'APPROVED' });
    expect(res.body.data.vendor.reviewedAt).not.toBeNull();

    const me = await request(app).get('/api/v1/users/me').set(user.auth);
    expect(me.body.data.user.roles).toEqual(['buyer', 'vendor']);

    expect((await request(app).get(`/api/v1/vendors/${vendor.id}`)).status).toBe(200);
  });

  test('is safe to repeat: approving an approved store re-grants the role', async () => {
    const { user, vendor } = await applicant();
    await approve(vendor.id);
    const { User } = require('../../src/modules/users/user.model');
    // Simulate a crash between the two writes of the first approval.
    await User.updateOne({ _id: user.userId }, { $pull: { roles: 'vendor' } });

    expect((await approve(vendor.id)).status).toBe(200);
    expect((await User.findById(user.userId)).roles).toEqual(['buyer', 'vendor']);
  });

  test('a rejected store cannot be approved; an unknown id is 404', async () => {
    const { vendor } = await applicant();
    await reject(vendor.id);
    const res = await approve(vendor.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_VENDOR_STATUS');

    expect((await approve('0123456789abcdef01234567')).status).toBe(404);
  });
});

describe('PATCH /admin/vendors/:id/reject', () => {
  test('rejects with a reason; the applicant can apply again and is PENDING once more', async () => {
    const { user, vendor } = await applicant();

    const res = await reject(vendor.id);
    expect(res.status).toBe(200);
    expect(res.body.data.vendor).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'Bank account name does not match',
    });

    const again = await request(app)
      .post('/api/v1/vendors/apply')
      .set(user.auth)
      .send({
        storeName: vendor.storeName,
        bank: { bankCode: '058', accountNumber: '9876543210', accountName: 'Test Vendor' },
      });
    expect(again.status).toBe(201);
    expect(again.body.data.vendor).toMatchObject({
      id: vendor.id,
      slug: vendor.slug,
      status: 'PENDING',
      rejectionReason: null,
      bank: { accountNumber: '******3210' },
    });
  });

  test('a reason is required', async () => {
    const { vendor } = await applicant();
    const res = await request(app)
      .patch(`/api/v1/admin/vendors/${vendor.id}/reject`)
      .set(admin.auth)
      .send({});
    expect(res.status).toBe(422);
  });

  test('an approved store cannot be rejected', async () => {
    const { vendor } = await applicant();
    await approve(vendor.id);
    expect((await reject(vendor.id)).status).toBe(409);
  });
});

describe('GET /admin/vendors', () => {
  test('lists by status with a cursor that never repeats or skips', async () => {
    const created = [];
    for (let i = 0; i < 3; i += 1) created.push((await applicant()).vendor.id);

    const seen = [];
    let cursor;
    do {
      const res = await request(app)
        .get('/api/v1/admin/vendors')
        .query({ status: 'PENDING', limit: 2, ...(cursor && { cursor }) })
        .set(admin.auth);
      expect(res.status).toBe(200);
      for (const v of res.body.data.items) {
        expect(v.status).toBe('PENDING');
        seen.push(v.id);
      }
      cursor = res.body.data.nextCursor;
    } while (cursor);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(created));
  });

  test('a garbage cursor, or a well-formed one with a bad id, is a 400', async () => {
    const forged = Buffer.from(JSON.stringify({ id: 'nope' })).toString('base64url');
    for (const cursor of ['not-base64-json', forged]) {
      const res = await request(app).get('/api/v1/admin/vendors').query({ cursor }).set(admin.auth);
      expect(res.status).toBe(400);
    }
  });
});
