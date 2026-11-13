process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { User } = require('../../src/modules/users/user.model');
const { useMongo } = require('../helpers/mongo');
const { register, tokenFromEmail, uniqueEmail } = require('../helpers/auth');

useMongo();
afterAll(() => postgres.close());

const app = createApp();

describe('POST /auth/register', () => {
  test('creates an unverified buyer, opens a Postgres wallet and emails a token', async () => {
    const { res, email } = await register(app, { name: 'Ada' });

    expect(res.status).toBe(201);
    const { user } = res.body.data;
    expect(user).toMatchObject({
      email,
      name: 'Ada',
      roles: ['buyer'],
      emailVerifiedAt: null,
      status: 'ACTIVE',
      walletStatus: 'READY',
    });
    expect(user.passwordHash).toBeUndefined();

    const stored = await User.findById(user.id).select('+passwordHash');
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);

    const wallet = await postgres
      .db('accounts')
      .where({ owner_type: 'USER', owner_id: user.id })
      .first();
    expect(wallet).toMatchObject({ balance_kobo: 0, currency: 'NGN' });

    expect(tokenFromEmail(email)).toHaveLength(43);
  });

  test('a second account with the same email (any case) is refused with 409', async () => {
    const email = uniqueEmail();
    await register(app, { email });
    const { res } = await register(app, { email: email.toUpperCase() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  test('invalid input is rejected with field errors', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toHaveProperty('email');
    expect(res.body.error.details).toHaveProperty('password');
  });

  test('wallet failure still registers the user, left PENDING for the reconciler', async () => {
    const { LedgerService } = require('../../src/modules/ledger');
    const spy = jest
      .spyOn(LedgerService, 'openUserAccount')
      .mockRejectedValueOnce(new Error('Postgres down'));
    try {
      const { res } = await register(app);
      expect(res.status).toBe(201);
      expect(res.body.data.user.walletStatus).toBe('PENDING');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('POST /auth/verify-email', () => {
  test('verifies the email once; the token cannot be reused', async () => {
    const { email } = await register(app);
    const token = tokenFromEmail(email);

    const first = await request(app).post('/api/v1/auth/verify-email').send({ token });
    expect(first.status).toBe(200);
    expect(first.body.data.user.emailVerifiedAt).not.toBeNull();

    const second = await request(app).post('/api/v1/auth/verify-email').send({ token });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('INVALID_TOKEN');
  });

  test('an unknown token is rejected', async () => {
    const res = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: 'x'.repeat(43) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });
});
