// SCOPE §13: every request body and query is validated with Zod.
// Each route must run validate() on exactly the parts its API docs say it
// takes (path params, query, body). The few routes with no input at all are
// listed, with the reason; the docs must agree that they take none.
process.env.NODE_ENV = 'test';

const { createApp } = require('../../src/app');
const { buildSpec } = require('../../src/docs/openapi');
const postgres = require('../../src/db/postgres');
const { expressRoutes } = require('../helpers/routes');

afterAll(() => postgres.close());

// Routes that take no params, query or body: nothing to validate.
const NO_INPUT = [
  'GET /health',
  'GET /health/ready',
  'GET /api/v1/users/me',
  'GET /api/v1/vendors/me',
  'GET /api/v1/cart',
  'GET /api/v1/wallet',
  'GET /api/v1/notifications/unread-count',
  'PATCH /api/v1/notifications/read-all',
  'GET /api/v1/admin/settings',
  'GET /api/v1/admin/reports/top-vendors',
  'GET /api/v1/admin/reports/escrow',
  'GET /api/v1/admin/reports/reconciliation',
];
// Validated, but not by validate() middleware, for a stated reason.
const VALIDATED_IN_SERVICE = {
  'POST /api/v1/webhooks/paystack':
    'raw body: the HMAC signature is checked first, then the event is parsed with Zod (webhooks.service)',
};

const app = createApp();
const spec = buildSpec();
const routes = expressRoutes(app).map((r) => ({
  ...r,
  key: `${r.method} ${r.path}`,
  parts: r.handlers.filter((h) => h.name === 'validateRequest').flatMap((h) => h.parts),
  op: spec.paths[r.path]?.[r.method.toLowerCase()],
}));

/** What the docs say a route takes. */
function documentedInput(op) {
  const params = op.parameters ?? [];
  return {
    params: params.some((p) => p.in === 'path'),
    query: params.some((p) => p.in === 'query'),
    body: Boolean(op.requestBody),
  };
}

test('there are routes to check', () => {
  expect(routes.length).toBeGreaterThan(60);
});

test.each(routes.map((r) => [r.key, r]))('%s validates what it takes', (key, route) => {
  expect(route.op).toBeDefined();
  if (VALIDATED_IN_SERVICE[key]) return;
  const input = documentedInput(route.op);

  if (NO_INPUT.includes(key)) {
    expect(input).toEqual({ params: false, query: false, body: false });
    return;
  }
  for (const part of ['params', 'query', 'body']) {
    if (input[part])
      expect({ key, validates: route.parts }).toEqual({
        key,
        validates: expect.arrayContaining([part]),
      });
  }
  expect(route.parts.length).toBeGreaterThan(0);
});

test('the lists above only name real routes', () => {
  const keys = routes.map((r) => r.key);
  for (const k of [...NO_INPUT, ...Object.keys(VALIDATED_IN_SERVICE)]) expect(keys).toContain(k);
});
