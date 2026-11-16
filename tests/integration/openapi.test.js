// The served API docs are valid OpenAPI, and they match the real routes in
// both directions: no undocumented route, no documented route that is not there.
process.env.NODE_ENV = 'test';

const request = require('supertest');
const SwaggerParser = require('@apidevtools/swagger-parser');
const { createApp } = require('../../src/app');
const { buildSpec } = require('../../src/docs/openapi');
const postgres = require('../../src/db/postgres');

afterAll(() => postgres.close());

const app = createApp();

/** Every [METHOD, path] the Express app serves, with :param written as {param}. */
function expressRoutes(expressApp) {
  const routes = [];
  const mountPath = (layer) =>
    layer.regexp.source.replace(/^\^/, '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          routes.push([method, `${prefix}${layer.route.path}`]);
        }
      } else if (layer.name === 'router' && layer.handle.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer));
      }
    }
  };
  walk(expressApp._router.stack, '');
  return routes
    .map(([m, p]) => [m, p.replace(/\/$/, '').replace(/:(\w+)/g, '{$1}')])
    .filter(([, p]) => !p.startsWith('/api-docs'));
}

const key = ([method, path]) => `${method.toUpperCase()} ${path}`;

test('the merged document is valid OpenAPI 3 and every $ref resolves', async () => {
  await expect(SwaggerParser.validate(buildSpec())).resolves.toBeTruthy();
});

test('every route the app serves is documented, and every documented route exists', () => {
  const spec = buildSpec();
  const documented = Object.entries(spec.paths).flatMap(([path, ops]) =>
    Object.keys(ops).map((method) => key([method, path])),
  );
  const served = expressRoutes(app).map(key);

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
