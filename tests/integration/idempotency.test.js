process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const postgres = require('../../src/db/postgres');
const { idempotent, canonicalJson } = require('../../src/shared/middleware/idempotency');
const { errorHandler } = require('../../src/shared/middleware/errorHandler');
const asyncHandler = require('../../src/shared/http/asyncHandler');

afterAll(() => postgres.close());

// A tiny app: the user comes from a header, the handler counts its runs and
// answers with whatever status the body asks for.
let runs = 0;
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.user = { id: req.get('x-test-user') };
  next();
});
app.post(
  '/thing',
  idempotent('test.thing'),
  asyncHandler(async (req, res) => {
    runs += 1;
    if (req.body.delayMs) await new Promise((r) => setTimeout(r, req.body.delayMs));
    if (req.body.crash) throw new Error('boom');
    res.status(req.body.status || 201).json({ success: true, data: { run: runs, echo: req.body } });
  }),
);
app.use(errorHandler);

const post = (key, body, user) => {
  const req = request(app).post('/thing').set('x-test-user', user).send(body);
  return key ? req.set('Idempotency-Key', key) : req;
};

let user;
beforeEach(() => {
  user = `idem-${randomUUID()}`;
});

describe('Idempotency-Key middleware', () => {
  test('no header is a 400 and the handler does not run', async () => {
    const before = runs;
    const res = await post(null, { a: 1 }, user);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(runs).toBe(before);
  });

  test('same key + same body replays the first response; the handler runs once', async () => {
    const key = randomUUID();
    const first = await post(key, { amount: 5000, note: 'x' }, user);
    // Same body, keys in a different order.
    const second = await post(key, { note: 'x', amount: 5000 }, user);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  test('same key + different body is a 409', async () => {
    const key = randomUUID();
    await post(key, { amount: 5000 }, user);
    const res = await post(key, { amount: 9000 }, user);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('keys are per user: the same key from another user is a new request', async () => {
    const key = randomUUID();
    const mine = await post(key, { amount: 1 }, user);
    const theirs = await post(key, { amount: 1 }, `idem-${randomUUID()}`);
    expect(theirs.body.data.run).not.toBe(mine.body.data.run);
  });

  test('parallel requests with one key: the handler runs exactly once', async () => {
    const key = randomUUID();
    const before = runs;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post(key, { delayMs: 300 }, user)),
    );
    expect(runs - before).toBe(1);
    // Each response is either the one real result (first or replayed) or a
    // "still running" refusal, depending on when it arrived.
    const winner = results.find((r) => r.status === 201 && !r.headers['idempotent-replayed']);
    expect(winner).toBeDefined();
    for (const r of results) {
      if (r.status === 201) expect(r.body).toEqual(winner.body);
      else expect(r.body.error.code).toBe('REQUEST_IN_PROGRESS');
    }
  });

  test('a 4xx answer is stored and replayed too', async () => {
    const key = randomUUID();
    const first = await post(key, { status: 422 }, user);
    const again = await post(key, { status: 422 }, user);
    expect(again.status).toBe(422);
    expect(again.body).toEqual(first.body);
  });

  test('a 5xx frees the key so a retry runs again', async () => {
    const key = randomUUID();
    expect((await post(key, { crash: true }, user)).status).toBe(500);
    const retry = await post(key, { crash: true }, user);
    expect(retry.status).toBe(500);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
  });

  test('a stale IN_PROGRESS key can be taken over by the same body, not a different one', async () => {
    const key = randomUUID();
    await postgres.db('idempotency_keys').insert({
      key,
      user_id: user,
      endpoint: 'test.thing',
      request_hash: require('../../src/shared/middleware/idempotency').hashBody({ a: 1 }),
      locked_at: postgres.db.raw("now() - interval '2 minutes'"),
    });
    expect((await post(key, { a: 2 }, user)).status).toBe(409);
    expect((await post(key, { a: 1 }, user)).status).toBe(201);
  });
});

test('canonicalJson ignores key order at every level', () => {
  expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } })).toBe(
    canonicalJson({ a: { c: null, d: [2, { x: 0, y: 1 }] }, b: 1 }),
  );
});
