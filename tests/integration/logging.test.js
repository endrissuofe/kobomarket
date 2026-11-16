// SCOPE §13: structured logs with a request ID on every line, and no
// passwords or tokens in them. Captures the real log output of one request
// through the full app, including a line written deep inside a service.
process.env.NODE_ENV = 'test';

const pino = require('pino');
const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { logger } = require('../../src/shared/logger');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
const stream = logger[pino.symbols.streamSym];
let lines = [];
let originalWrite;
let originalLevel;

beforeAll(() => {
  originalWrite = stream.write;
  originalLevel = logger.level;
  stream.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
});
afterAll(() => {
  stream.write = originalWrite;
  logger.level = originalLevel;
});

test('every log line of a request is JSON with the same request ID; tokens are redacted', async () => {
  const admin = await signIn(app, { roles: ['buyer', 'admin'] });
  const current = await request(app).get('/api/v1/admin/settings').set(admin.auth);
  const before = current.body.data.settings.commissionBps;

  logger.level = 'info';
  // pino-http makes its child logger when the app is built, so build one now
  // that logging is on.
  const loggingApp = createApp();
  lines = [];
  // The service logs "Commission rate changed"; pino-http logs the request.
  const res = await request(loggingApp)
    .patch('/api/v1/admin/settings/commission')
    .set(admin.auth)
    .set('x-request-id', 'test-request-123')
    .send({ commissionBps: before });
  logger.level = originalLevel;

  expect(res.status).toBe(200);
  expect(res.headers['x-request-id']).toBe('test-request-123');

  const entries = lines.map((l) => JSON.parse(l));
  const messages = entries.map((e) => e.msg);
  expect(messages).toEqual(
    expect.arrayContaining(['Commission rate changed', 'request completed']),
  );
  for (const entry of entries) {
    expect(entry).toMatchObject({
      requestId: 'test-request-123',
      level: expect.any(Number),
      time: expect.any(Number),
    });
  }

  const raw = lines.join('');
  expect(raw).not.toContain(admin.accessToken);
  expect(raw).toContain('[redacted]');
});

test('without an incoming X-Request-Id a new one is made and returned', async () => {
  const res = await request(app).get('/health');
  expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
});

test('passwords never reach the logs', async () => {
  logger.level = 'info';
  const loggingApp = createApp();
  lines = [];
  await request(loggingApp)
    .post('/api/v1/auth/login')
    .send({ email: 'nobody@kobomarket.test', password: 'a-secret-password' });
  logger.level = originalLevel;
  expect(lines.join('')).not.toContain('a-secret-password');
});
