process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../../src/config');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { requireAuth, requireRole } = require('../../src/shared/middleware/auth');
const { errorHandler } = require('../../src/shared/middleware/errorHandler');
const { User } = require('../../src/modules/users/user.model');
const { useMongo } = require('../helpers/mongo');
const { registerVerified } = require('../helpers/auth');

useMongo();
afterAll(() => postgres.close());

const app = createApp();

// A tiny app with guarded routes, to test the middleware on its own.
const guarded = express();
guarded.get('/vendor', requireAuth, requireRole('vendor'), (req, res) => res.json({ ok: true }));
guarded.get('/admin', requireAuth, requireRole('admin'), (req, res) => res.json({ ok: true }));
guarded.use(errorHandler);

async function loginNew() {
  const creds = await registerVerified(app);
  const res = await request(app).post('/api/v1/auth/login').send(creds);
  return { ...res.body.data, userId: creds.user.id };
}
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe('requireAuth', () => {
  test('GET /users/me returns the signed-in user', async () => {
    const { accessToken, user } = await loginNew();
    const res = await request(app).get('/api/v1/users/me').set(bearer(accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: user.id, email: user.email });
  });

  test('no token, a bad token and an expired token are all 401', async () => {
    const { userId, user } = await loginNew();
    const expired = jwt.sign(
      { roles: user.roles, sid: 'x', exp: Math.floor(Date.now() / 1000) - 10 },
      config.auth.accessSecret,
      { subject: userId },
    );
    const forged = jwt.sign({ roles: ['admin'], sid: 'x' }, 'not-the-secret', { subject: userId });

    const cases = [
      [{}, 'UNAUTHORIZED'],
      [bearer('garbage'), 'INVALID_TOKEN'],
      [bearer(forged), 'INVALID_TOKEN'],
      [bearer(expired), 'TOKEN_EXPIRED'],
    ];
    for (const [headers, code] of cases) {
      const res = await request(app).get('/api/v1/users/me').set(headers);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(code);
    }
  });

  test('after logout the access token is refused at once', async () => {
    const { accessToken, refreshToken } = await loginNew();
    await request(app).post('/api/v1/auth/logout').send({ refreshToken });
    const res = await request(app).get('/api/v1/users/me').set(bearer(accessToken));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_REVOKED');
  });
});

describe('requireRole', () => {
  test('a buyer is refused vendor and admin routes with 403', async () => {
    const { accessToken } = await loginNew();
    for (const path of ['/vendor', '/admin']) {
      const res = await request(guarded).get(path).set(bearer(accessToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  test('roles are read from the database, so a new role applies without logging in again', async () => {
    const { accessToken, userId } = await loginNew();
    await User.updateOne({ _id: userId }, { $addToSet: { roles: 'vendor' } });
    expect((await request(guarded).get('/vendor').set(bearer(accessToken))).status).toBe(200);
    expect((await request(guarded).get('/admin').set(bearer(accessToken))).status).toBe(403);
  });
});
