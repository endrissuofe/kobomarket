process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { useMongo } = require('../helpers/mongo');

useMongo();
afterAll(() => postgres.close());

describe('general API rate limit', () => {
  const app = createApp({ rateLimit: { windowMs: 60_000, max: 3 } });

  test('the 4th API request in the window gets 429 in the standard error shape', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get('/api/v1/products')).status).toBe(200);
    }
    const res = await request(app).get('/api/v1/products');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'RATE_LIMITED', message: expect.any(String) },
    });
    expect(res.headers).toHaveProperty('ratelimit');
  });

  test('health checks and the payment webhook are not limited', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
    // Unsigned, so 401 from the webhook itself, not 429 from the limiter.
    expect((await request(app).post('/api/v1/webhooks/paystack').send('{}')).status).toBe(401);
  });
});
