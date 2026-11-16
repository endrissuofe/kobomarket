const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const MODULES_DIR = path.join(__dirname, '..', 'modules');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// Shared parts every module fragment can reference.
const base = {
  openapi: '3.0.3',
  info: {
    title: 'KoboMarket API',
    version: '1.0.0',
    description: [
      'Multi-vendor marketplace backend with wallets, a double-entry ledger and escrow.',
      '',
      '- **Money** is always an integer number of **kobo** (NGN 1 = 100 kobo).',
      '- **Auth:** log in, then send `Authorization: Bearer <accessToken>` (15 minutes; refresh with `/auth/refresh`).',
      '- **Idempotency:** `POST /wallet/fund`, `POST /orders/checkout` and `POST /payouts` need an `Idempotency-Key` header. The same key and body return the first response; the same key with a different body is a 409.',
      '- **Errors** always look like `{ success: false, error: { code, message, details } }`.',
      '- **Lists** use cursor pagination: pass `nextCursor` back as `cursor`.',
      '- **Demo data:** `npm run seed`; every demo account uses the password `KoboMarket#2026`.',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'This server' }],
  tags: [
    { name: 'Health' },
    { name: 'Auth' },
    { name: 'Users' },
    { name: 'Vendors' },
    { name: 'Products' },
    { name: 'Cart' },
    { name: 'Wallet' },
    { name: 'Webhooks' },
    { name: 'Orders' },
    { name: 'Disputes' },
    { name: 'Payouts' },
    { name: 'Notifications' },
    { name: 'Admin' },
    { name: 'Admin reports' },
    { name: 'Mock provider', description: 'Only when PAYMENT_PROVIDER=mock' },
  ],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      ErrorResponse: {
        type: 'object',
        required: ['success', 'error'],
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', example: 'VALIDATION_ERROR' },
              message: { type: 'string' },
              details: { description: 'Field errors, limits or ids that explain the error' },
            },
          },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness: the process is up',
        responses: { 200: { description: '{ success: true, data: { status: "ok" } }' } },
      },
    },
    '/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness: PostgreSQL and MongoDB are reachable',
        responses: {
          200: { description: '{ status: "ready", checks: { postgres: "ok", mongo: "ok" } }' },
          503: { description: 'A database is unreachable (checks show which)' },
        },
      },
    },
  },
};

function fragmentFiles() {
  return fs
    .readdirSync(MODULES_DIR)
    .flatMap((mod) =>
      fs
        .readdirSync(path.join(MODULES_DIR, mod))
        .filter((f) => f.endsWith('.docs.yaml'))
        .map((f) => path.join(MODULES_DIR, mod, f)),
    )
    .sort();
}

/**
 * Merge every module's *.docs.yaml into one OpenAPI document. Two fragments
 * may share a path with different methods; the same path + method, or the
 * same component name, twice is an error (never a silent overwrite).
 */
function buildSpec() {
  const spec = structuredClone(base);
  for (const file of fragmentFiles()) {
    const where = path.relative(process.cwd(), file);
    const fragment = yaml.load(fs.readFileSync(file, 'utf8')) ?? {};

    for (const [route, ops] of Object.entries(fragment.paths ?? {})) {
      spec.paths[route] ??= {};
      for (const [method, op] of Object.entries(ops)) {
        if (!METHODS.includes(method))
          throw new Error(`${where}: unknown method ${method} on ${route}`);
        if (spec.paths[route][method])
          throw new Error(`${where}: ${method.toUpperCase()} ${route} is documented twice`);
        // Every operation can fail with the standard error body.
        op.responses ??= {};
        op.responses.default ??= {
          description: 'Error',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        };
        spec.paths[route][method] = op;
      }
    }

    for (const [kind, entries] of Object.entries(fragment.components ?? {})) {
      spec.components[kind] ??= {};
      for (const [name, value] of Object.entries(entries)) {
        if (spec.components[kind][name])
          throw new Error(`${where}: components.${kind}.${name} is defined twice`);
        spec.components[kind][name] = value;
      }
    }
  }
  return spec;
}

let cached;
/** The merged document, built once per process. */
function getSpec() {
  cached ??= buildSpec();
  return cached;
}

module.exports = { buildSpec, getSpec };
