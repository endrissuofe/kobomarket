process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { useMongo } = require('../helpers/mongo');
const { registerVerified } = require('../helpers/auth');

useMongo();
afterAll(() => postgres.close());

const app = createApp();

async function loginAs({ email, password }) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.data;
}
const refresh = (refreshToken) => request(app).post('/api/v1/auth/refresh').send({ refreshToken });

describe('POST /auth/refresh', () => {
  test('rotates: returns a new pair, and the new refresh token rotates again', async () => {
    const creds = await registerVerified(app);
    const first = await loginAs(creds);

    const res = await refresh(first.refreshToken);
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).not.toBe(first.refreshToken);
    expect(res.body.data.accessToken).toEqual(expect.any(String));

    const again = await refresh(res.body.data.refreshToken);
    expect(again.status).toBe(200);
  });

  // Required test 2
  test('a reused refresh token is rejected and kills all sessions', async () => {
    const creds = await registerVerified(app);
    const laptop = await loginAs(creds);
    const phone = await loginAs(creds);

    const rotated = await refresh(laptop.refreshToken);
    expect(rotated.status).toBe(200);

    // An attacker replays the laptop's old token.
    const reuse = await refresh(laptop.refreshToken);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // Every session is gone: the laptop's new token and the phone's token.
    for (const token of [rotated.body.data.refreshToken, phone.refreshToken]) {
      const res = await refresh(token);
      expect(res.status).toBe(401);
    }

    // Access tokens already issued stop working too.
    const me = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${phone.accessToken}`);
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_REVOKED');
  });

  test('two parallel refreshes with one token: exactly one wins', async () => {
    const creds = await registerVerified(app);
    const { refreshToken } = await loginAs(creds);

    const results = await Promise.all([refresh(refreshToken), refresh(refreshToken)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  test('an unknown refresh token is rejected', async () => {
    const res = await refresh('y'.repeat(43));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });
});

describe('POST /auth/logout', () => {
  test('revokes that device only, and is safe to repeat', async () => {
    const creds = await registerVerified(app);
    const laptop = await loginAs(creds);
    const phone = await loginAs(creds);

    const out = await request(app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: laptop.refreshToken });
    expect(out.status).toBe(204);

    const repeat = await request(app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: laptop.refreshToken });
    expect(repeat.status).toBe(204);

    expect((await refresh(laptop.refreshToken)).status).toBe(401);
    expect((await refresh(phone.refreshToken)).status).toBe(200);
  });
});
