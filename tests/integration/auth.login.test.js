process.env.NODE_ENV = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { useMongo } = require('../helpers/mongo');
const { register, registerVerified, uniqueEmail } = require('../helpers/auth');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
const login = (body) => request(app).post('/api/v1/auth/login').send(body);

describe('POST /auth/login', () => {
  // Required test 1
  test('a user cannot log in before verifying their email', async () => {
    const { email, password } = await register(app);
    const res = await login({ email, password });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(res.body.data).toBeUndefined();
  });

  test('a verified user gets a 15-minute access token and a refresh token', async () => {
    const { email, password, user } = await registerVerified(app);
    const res = await login({ email, password });

    expect(res.status).toBe(200);
    const { accessToken, refreshToken, tokenType } = res.body.data;
    expect(tokenType).toBe('Bearer');
    expect(refreshToken).toHaveLength(43);

    const claims = jwt.decode(accessToken);
    expect(claims.sub).toBe(user.id);
    expect(claims.roles).toEqual(['buyer']);
    expect(claims.sid).toEqual(expect.any(String));
    expect(claims.exp - claims.iat).toBe(15 * 60);
  });

  test('wrong password and unknown email give the same 401', async () => {
    const { email } = await registerVerified(app);
    const wrong = await login({ email, password: 'not-the-password' });
    const unknown = await login({ email: uniqueEmail(), password: 'whatever-it-is' });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }
  });

  test('the 6th attempt within 15 minutes is blocked with 429, even with the right password', async () => {
    const { email, password } = await registerVerified(app);
    for (let i = 0; i < 5; i += 1) {
      expect((await login({ email, password: 'wrong-password' })).status).toBe(401);
    }
    const blocked = await login({ email, password });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(blocked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('parallel wrong guesses cannot get past the limit', async () => {
    const { email } = await registerVerified(app);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => login({ email, password: 'wrong-password' })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });

  test('a successful login resets the failure count', async () => {
    const { email, password } = await registerVerified(app);
    for (let i = 0; i < 4; i += 1) await login({ email, password: 'wrong-password' });
    expect((await login({ email, password })).status).toBe(200);
    for (let i = 0; i < 4; i += 1) await login({ email, password: 'wrong-password' });
    expect((await login({ email, password })).status).toBe(200);
  });
});
