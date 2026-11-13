process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const mailer = require('../../src/integrations/email');
const { useMongo } = require('../helpers/mongo');
const { register, registerVerified, tokenFromEmail, uniqueEmail } = require('../helpers/auth');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
const NEW_PASSWORD = 'a-brand-new-password';

const forgot = (email) => request(app).post('/api/v1/auth/forgot-password').send({ email });
const reset = (token, password = NEW_PASSWORD) =>
  request(app).post('/api/v1/auth/reset-password').send({ token, password });
const login = (email, password) =>
  request(app).post('/api/v1/auth/login').send({ email, password });

describe('forgot / reset password', () => {
  test('an unknown email gets the same 200 and no email is sent', async () => {
    const email = uniqueEmail();
    const res = await forgot(email);
    expect(res.status).toBe(200);
    expect(mailer.lastMessageTo(email)).toBeUndefined();
  });

  test('reset sets the new password, signs out every session, and the token is single-use', async () => {
    const { email, password } = await registerVerified(app);
    const session = (await login(email, password)).body.data;

    expect((await forgot(email)).status).toBe(200);
    const token = tokenFromEmail(email);

    expect((await reset(token)).status).toBe(200);
    expect((await reset(token)).body.error.code).toBe('INVALID_TOKEN');

    expect((await login(email, password)).status).toBe(401);
    expect((await login(email, NEW_PASSWORD)).status).toBe(200);

    const refresh = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken });
    expect(refresh.status).toBe(401);

    const me = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_REVOKED');
  });

  test('requesting a new link retires the previous one', async () => {
    const { email } = await registerVerified(app);
    await forgot(email);
    const oldToken = tokenFromEmail(email);
    await forgot(email);
    const newToken = tokenFromEmail(email);

    expect((await reset(oldToken)).status).toBe(400);
    expect((await reset(newToken)).status).toBe(200);
  });

  test('a reset link also verifies an unverified email', async () => {
    const { email } = await register(app);
    await forgot(email);
    await reset(tokenFromEmail(email));
    expect((await login(email, NEW_PASSWORD)).status).toBe(200);
  });

  test('the new password must meet the rules', async () => {
    const res = await reset('z'.repeat(43), 'short');
    expect(res.status).toBe(422);
    expect(res.body.error.details).toHaveProperty('password');
  });
});
