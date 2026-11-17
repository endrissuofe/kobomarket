// The served API docs are valid OpenAPI, and they match the real routes in
// both directions: no undocumented route, no documented route that is not there.
process.env.NODE_ENV = 'test';

const request = require('supertest');
const SwaggerParser = require('@apidevtools/swagger-parser');
const { createApp } = require('../../src/app');
const { buildSpec } = require('../../src/docs/openapi');
const postgres = require('../../src/db/postgres');
const { expressRoutes } = require('../helpers/routes');

afterAll(() => postgres.close());

const app = createApp();

const key = ([method, path]) => `${method.toUpperCase()} ${path}`;

test('the merged document is valid OpenAPI 3 and every $ref resolves', async () => {
  await expect(SwaggerParser.validate(buildSpec())).resolves.toBeTruthy();
});

test('every route the app serves is documented, and every documented route exists', () => {
  const spec = buildSpec();
  const documented = Object.entries(spec.paths).flatMap(([path, ops]) =>
    Object.keys(ops).map((method) => key([method, path])),
  );
  const served = expressRoutes(app).map((r) => key([r.method, r.path]));

  expect(served.length).toBeGreaterThan(50);
  expect([...new Set(served)].filter((r) => !documented.includes(r)).sort()).toEqual([]);
  expect(documented.filter((r) => !served.includes(r)).sort()).toEqual([]);
});

test('Swagger UI is at /api-docs and the raw document at /api-docs.json', async () => {
  const ui = await request(app).get('/api-docs/');
  expect(ui.status).toBe(200);
  expect(ui.text).toContain('swagger-ui');

  const json = await request(app).get('/api-docs.json');
  expect(json.status).toBe(200);
  expect(json.body.info.title).toBe('KoboMarket API');
  expect(json.body.paths['/api/v1/orders/checkout'].post).toBeDefined();
});

test('the committed Postman collection matches the API docs (run npm run postman:generate)', () => {
  const fs = require('node:fs');
  const { serialize, OUT } = require('../../scripts/generate-postman');
  expect(fs.readFileSync(OUT, 'utf8')).toBe(serialize());

  const collection = JSON.parse(serialize());
  const endpoints = collection.item[1].item.flatMap((folder) => folder.item);
  const operations = Object.values(buildSpec().paths).reduce(
    (n, ops) => n + Object.keys(ops).length,
    0,
  );
  expect(endpoints).toHaveLength(operations);
});

test("every endpoint in the brief's list is served: none may be removed", () => {
  // The 48 endpoints the brief lists, kept in tests/fixtures/required-endpoints.json.
  const required = require('../fixtures/required-endpoints.json');
  const listed = required.map((line) => {
    const [method, path] = line.split(' ');
    return `${method} /api/v1${path}`;
  });
  // Compare with parameter names ignored: /orders/:id and /orders/{id} match.
  const shape = (k) => k.replace(/[:{]\w+}?/g, '{}');
  const served = new Set(expressRoutes(app).map((r) => shape(`${r.method} ${r.path}`)));

  // The brief lists exactly 48 (7 auth, 4 users/vendors, 6 products, 4 cart, 4 wallet,
  // 6 orders, 3 disputes, 2 payouts, 3 notifications, 9 admin).
  expect(listed).toHaveLength(48);
  expect(listed.filter((k) => !served.has(shape(k)))).toEqual([]);
});
