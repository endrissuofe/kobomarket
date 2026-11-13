process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');

useMongo();
afterAll(() => postgres.close());

const app = createApp();

describe('PATCH /users/me', () => {
  test('updates the name', async () => {
    const user = await signIn(app);
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set(user.auth)
      .send({ name: '  Ada Obi ' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe('Ada Obi');
    const me = await request(app).get('/api/v1/users/me').set(user.auth);
    expect(me.body.data.user.name).toBe('Ada Obi');
  });

  test.each([
    [{ roles: ['admin'] }],
    [{ email: 'new@example.com' }],
    [{ walletStatus: 'READY', name: 'x' }],
    [{ status: 'ACTIVE' }],
    [{}],
    [{ name: '' }],
  ])('refuses %o with 422 and changes nothing', async (body) => {
    const user = await signIn(app);
    const res = await request(app).patch('/api/v1/users/me').set(user.auth).send(body);
    expect(res.status).toBe(422);
    const me = await request(app).get('/api/v1/users/me').set(user.auth);
    expect(me.body.data.user.roles).toEqual(['buyer']);
    expect(me.body.data.user.email).toBe(user.email);
  });

  test('needs a signed-in user', async () => {
    expect((await request(app).patch('/api/v1/users/me').send({ name: 'x' })).status).toBe(401);
  });
});
