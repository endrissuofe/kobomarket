// npm run postman:generate: writes docs/postman/KoboMarket.postman_collection.json
// from the OpenAPI document, plus a curated "Demo flow" folder that runs the
// whole story against the seed data (npm run seed), saving ids as it goes.
const fs = require('node:fs');
const path = require('node:path');
const { buildSpec } = require('../src/docs/openapi');
const { DEMO_PASSWORD } = require('../seeds/demo-data');

const OUT = path.join(__dirname, '..', 'docs', 'postman', 'KoboMarket.postman_collection.json');

// --- building blocks ---

const json = (body) => ({
  mode: 'raw',
  raw: JSON.stringify(body, null, 2),
  options: { raw: { language: 'json' } },
});
const bearer = (variable) => ({
  type: 'bearer',
  bearer: [{ key: 'token', value: `{{${variable}}}`, type: 'string' }],
});
const noAuth = { type: 'noauth' };

function url(rawPath, query = []) {
  const clean = rawPath.split('?')[0];
  return {
    raw: `{{baseUrl}}${rawPath}`,
    host: ['{{baseUrl}}'],
    path: clean.replace(/^\//, '').split('/'),
    query: query.map(([key, value, disabled]) => ({
      key,
      value,
      ...(disabled && { disabled: true }),
    })),
  };
}

/** A request; `test` lines run after the response (pm.* API). */
function request(name, method, rawPath, { body, auth, query, test, description } = {}) {
  return {
    name,
    ...(test && { event: [{ listen: 'test', script: { type: 'text/javascript', exec: test } }] }),
    request: {
      method,
      header: body ? [{ key: 'Content-Type', value: 'application/json' }] : [],
      url: url(rawPath, query),
      ...(body && { body: json(body) }),
      ...(auth && { auth }),
      ...(description && { description }),
    },
  };
}

const expectStatus = (...codes) => [
  `pm.test('status ${codes.join(' or ')}', () => pm.expect(pm.response.code).to.be.oneOf([${codes.join(', ')}]));`,
];
const save = (pairs) =>
  Object.entries(pairs).map(([name, expr]) => `pm.collectionVariables.set('${name}', ${expr});`);
const body = 'const b = pm.response.json();';

// --- Demo flow ---

function login(label, email, tokenVar) {
  return request(`Log in as ${label}`, 'POST', '/api/v1/auth/login', {
    auth: noAuth,
    body: { email, password: DEMO_PASSWORD },
    test: [
      ...expectStatus(200),
      body,
      ...save({ [tokenVar]: 'b.data.accessToken', accessToken: 'b.data.accessToken' }),
      `pm.collectionVariables.set('${tokenVar.replace('Token', 'Id')}', b.data.user.id);`,
    ],
  });
}

const buyer = bearer('buyerToken');
const vendor = bearer('vendorToken');
const admin = bearer('adminToken');

const demoFlow = [
  login('buyer (Chioma)', 'chioma@kobomarket.test', 'buyerToken'),
  login('vendor (Ada)', 'ada@kobomarket.test', 'vendorToken'),
  login('admin', 'admin@kobomarket.test', 'adminToken'),

  request('Vendor: my store (save vendorId)', 'GET', '/api/v1/vendors/me', {
    auth: vendor,
    test: [...expectStatus(200), body, ...save({ vendorId: 'b.data.vendor.id' })],
  }),
  request("Browse Ada's products (pick one without variants)", 'GET', '/api/v1/products', {
    auth: noAuth,
    query: [
      ['vendorId', '{{vendorId}}'],
      ['sort', 'price_asc'],
      ['limit', '50'],
    ],
    test: [
      ...expectStatus(200),
      body,
      'const p = b.data.items.find((x) => x.variants.length === 0 && x.stock >= 2);',
      "pm.test('a product with stock', () => pm.expect(p).to.exist);",
      ...save({ productId: 'p.id', productSlug: 'p.slug', productPriceKobo: 'p.priceKobo' }),
    ],
  }),
  request('Product detail by slug', 'GET', '/api/v1/products/{{productSlug}}', {
    auth: noAuth,
    test: expectStatus(200),
  }),

  request('Fund wallet (NGN 20,000)', 'POST', '/api/v1/wallet/fund', {
    auth: buyer,
    body: { amountKobo: 2_000_000 },
    test: [...expectStatus(201), body, ...save({ fundingRef: 'b.data.funding.reference' })],
  }),
  request(
    'Pay on the mock checkout (sends the webhook twice)',
    'POST',
    '/mock-paystack/checkout/{{fundingRef}}/pay',
    {
      auth: noAuth,
      test: [
        ...expectStatus(200),
        body,
        "pm.test('both webhooks accepted', () => pm.expect(b.data.webhookDeliveries).to.eql([200, 200]));",
      ],
    },
  ),
  request('Wallet balance', 'GET', '/api/v1/wallet', {
    auth: buyer,
    test: [...expectStatus(200), body, ...save({ walletId: 'b.data.wallet.accountId' })],
  }),

  request('Add the product to the cart', 'POST', '/api/v1/cart/items', {
    auth: buyer,
    body: { productId: '{{productId}}', qty: 1 },
    test: [...expectStatus(201), body, ...save({ cartItemId: 'b.data.cart.items[0].id' })],
  }),
  request('Review the cart', 'GET', '/api/v1/cart', {
    auth: buyer,
    test: [
      ...expectStatus(200),
      body,
      "pm.test('cart is ready', () => pm.expect(b.data.cart.ready).to.be.true);",
    ],
  }),
  request('Check out (Idempotency-Key added automatically)', 'POST', '/api/v1/orders/checkout', {
    auth: buyer,
    body: {},
    test: [
      ...expectStatus(201),
      body,
      ...save({ orderId: 'b.data.order.id', subOrderId: 'b.data.order.subOrders[0].id' }),
    ],
  }),

  request('Vendor: my sub-orders', 'GET', '/api/v1/vendors/me/sub-orders', {
    auth: vendor,
    query: [['status', 'PAID']],
    test: expectStatus(200),
  }),
  request('Vendor: ship it', 'PATCH', '/api/v1/sub-orders/{{subOrderId}}/ship', {
    auth: vendor,
    body: { courierName: 'GIG Logistics', trackingNumber: 'GIG-2026-0001' },
    test: [
      ...expectStatus(200),
      body,
      "pm.test('SHIPPED', () => pm.expect(b.data.subOrder.status).to.eql('SHIPPED'));",
    ],
  }),
  request(
    'Buyer: confirm delivery (escrow released)',
    'PATCH',
    '/api/v1/sub-orders/{{subOrderId}}/confirm',
    {
      auth: buyer,
      test: [
        ...expectStatus(200),
        body,
        "pm.test('COMPLETED', () => pm.expect(b.data.subOrder.status).to.eql('COMPLETED'));",
      ],
    },
  ),
  request('Vendor: wallet after release', 'GET', '/api/v1/wallet', {
    auth: vendor,
    test: expectStatus(200),
  }),
  request('Vendor: request a payout (NGN 1,000)', 'POST', '/api/v1/payouts', {
    auth: vendor,
    body: { amountKobo: 100_000 },
    description:
      'Without the worker running, a second run of the flow gets 409 PAYOUT_PENDING until the first payout is processed.',
    test: [...expectStatus(201, 409)],
  }),
  request('Vendor: my payouts', 'GET', '/api/v1/payouts', {
    auth: vendor,
    test: expectStatus(200),
  }),

  request('Dispute: buy again', 'POST', '/api/v1/cart/items', {
    auth: buyer,
    body: { productId: '{{productId}}', qty: 1 },
    test: expectStatus(201),
  }),
  request('Dispute: check out', 'POST', '/api/v1/orders/checkout', {
    auth: buyer,
    body: {},
    test: [
      ...expectStatus(201),
      body,
      ...save({ disputedSubOrderId: 'b.data.order.subOrders[0].id' }),
    ],
  }),
  request('Dispute: vendor ships', 'PATCH', '/api/v1/sub-orders/{{disputedSubOrderId}}/ship', {
    auth: vendor,
    body: { courierName: 'GIG Logistics', trackingNumber: 'GIG-2026-0002' },
    test: expectStatus(200),
  }),
  request(
    'Dispute: buyer opens a dispute',
    'POST',
    '/api/v1/sub-orders/{{disputedSubOrderId}}/disputes',
    {
      auth: buyer,
      body: {
        reason: 'The scarf arrived torn along one edge',
        evidence: [{ type: 'image', value: 'https://picsum.photos/seed/torn-scarf/600/600' }],
      },
      test: [...expectStatus(201), body, ...save({ disputeId: 'b.data.dispute.id' })],
    },
  ),
  request(
    'Dispute: vendor replies with evidence',
    'PATCH',
    '/api/v1/disputes/{{disputeId}}/respond',
    {
      auth: vendor,
      body: {
        response: 'It left our store intact; courier photo attached',
        evidence: [{ type: 'image', value: 'https://picsum.photos/seed/packed-scarf/600/600' }],
      },
      test: expectStatus(200),
    },
  ),
  request(
    'Dispute: admin resolves with a partial refund (NGN 2,000)',
    'PATCH',
    '/api/v1/disputes/{{disputeId}}/resolve',
    {
      auth: admin,
      body: {
        resolution: 'PARTIAL_REFUND',
        refundKobo: 200_000,
        note: 'Minor damage; partial refund agreed with both sides',
      },
      test: [
        ...expectStatus(200),
        body,
        "pm.test('RESOLVED', () => pm.expect(b.data.dispute.status).to.eql('RESOLVED'));",
      ],
    },
  ),

  request('Buyer: notifications', 'GET', '/api/v1/notifications', {
    auth: buyer,
    description:
      'Notifications are created by the worker; without it running this list may be empty.',
    test: [
      ...expectStatus(200),
      body,
      "if (b.data.items[0]) pm.collectionVariables.set('notificationId', b.data.items[0].id);",
    ],
  }),
  request('Admin: revenue today', 'GET', '/api/v1/admin/reports/revenue', {
    auth: admin,
    query: [
      ['from', '{{today}}'],
      ['to', '{{today}}'],
    ],
    test: expectStatus(200),
  }),
  request('Admin: top vendors this month', 'GET', '/api/v1/admin/reports/top-vendors', {
    auth: admin,
    test: expectStatus(200),
  }),
  request('Admin: money in escrow', 'GET', '/api/v1/admin/reports/escrow', {
    auth: admin,
    test: expectStatus(200),
  }),
  request(
    'Admin: reconciliation (should be empty)',
    'GET',
    '/api/v1/admin/reports/reconciliation',
    {
      auth: admin,
      test: [
        ...expectStatus(200),
        body,
        "pm.test('no mismatches', () => pm.expect(b.data.ok).to.be.true);",
      ],
    },
  ),
];

// --- All endpoints, generated from the OpenAPI document ---

// Example bodies for "METHOD path"; everything else gets the schema's shape.
const EXAMPLES = {
  'POST /api/v1/auth/register': {
    email: 'new.buyer@kobomarket.test',
    password: DEMO_PASSWORD,
    name: 'New Buyer',
  },
  'POST /api/v1/auth/verify-email': { token: '<token from the console email>' },
  'POST /api/v1/auth/login': { email: 'chioma@kobomarket.test', password: DEMO_PASSWORD },
  'POST /api/v1/auth/refresh': { refreshToken: '<refreshToken from login>' },
  'POST /api/v1/auth/logout': { refreshToken: '<refreshToken from login>' },
  'POST /api/v1/auth/forgot-password': { email: 'chioma@kobomarket.test' },
  'POST /api/v1/auth/reset-password': {
    token: '<token from the console email>',
    password: 'a-new-password',
  },
  'PATCH /api/v1/users/me': { name: 'Chioma E.' },
  'POST /api/v1/vendors/apply': {
    storeName: 'My New Store',
    description: 'What I sell',
    bank: { bankCode: '058', accountNumber: '0123456789', accountName: 'Store Owner' },
  },
  'PATCH /api/v1/admin/vendors/{id}/reject': { reason: 'Bank account name does not match' },
  'POST /api/v1/products': {
    name: 'Adire Table Runner',
    category: 'home',
    priceKobo: 750_000,
    stock: 10,
    tags: ['adire'],
  },
  'PATCH /api/v1/products/{id}': { priceKobo: 700_000, stock: 12 },
  'POST /api/v1/products/{id}/reviews': { rating: 5, comment: 'Beautiful work' },
  'POST /api/v1/cart/items': { productId: '{{productId}}', qty: 1 },
  'PATCH /api/v1/cart/items/{itemId}': { qty: 2 },
  'POST /api/v1/wallet/fund': { amountKobo: 1_000_000 },
  'POST /api/v1/orders/checkout': {},
  'PATCH /api/v1/sub-orders/{id}/ship': {
    courierName: 'GIG Logistics',
    trackingNumber: 'GIG-123456',
  },
  'POST /api/v1/sub-orders/{id}/disputes': {
    reason: 'Item arrived damaged',
    evidence: [{ type: 'text', value: 'Box was crushed' }],
  },
  'PATCH /api/v1/disputes/{id}/respond': {
    response: 'Packed safely; courier signed for it',
    evidence: [],
  },
  'PATCH /api/v1/disputes/{id}/resolve': {
    resolution: 'PARTIAL_REFUND',
    refundKobo: 100_000,
    note: 'Partial refund agreed',
  },
  'POST /api/v1/payouts': { amountKobo: 100_000 },
  'PATCH /api/v1/admin/users/{id}/freeze': { reason: 'Suspicious activity' },
  'PATCH /api/v1/admin/settings/commission': { commissionBps: 500 },
};

// Path parameter -> collection variable, by the path it appears in.
function variableFor(route, param) {
  if (param === 'slug') return 'productSlug';
  if (param === 'itemId') return 'cartItemId';
  if (param === 'reference') return 'fundingRef';
  const rules = [
    [/^\/api\/v1\/products\//, 'productId'],
    [/^\/api\/v1\/orders\//, 'orderId'],
    [/^\/api\/v1\/sub-orders\//, 'subOrderId'],
    [/^\/api\/v1\/disputes\//, 'disputeId'],
    [/^\/api\/v1\/notifications\//, 'notificationId'],
    [/^\/api\/v1\/admin\/users\//, 'buyerId'],
    [/^\/api\/v1\/admin\/wallets\//, 'walletId'],
    [/vendors\//, 'vendorId'],
  ];
  return rules.find(([re]) => re.test(route))?.[1] ?? param;
}

function allEndpoints(spec) {
  const folders = new Map();
  for (const [route, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const tag = op.tags?.[0] ?? 'Other';
      const rawPath = route.replace(/\{(\w+)\}/g, (_, p) => `{{${variableFor(route, p)}}}`);
      const query = (op.parameters ?? [])
        .filter((p) => p.in === 'query')
        .map((p) => [
          p.name,
          p.required ? `{{${p.name === 'from' || p.name === 'to' ? 'today' : p.name}}}` : '',
          !p.required,
        ]);
      const key = `${method.toUpperCase()} ${route}`;
      const hasBody = Boolean(op.requestBody);
      const item = request(
        `${method.toUpperCase()} ${route.replace('/api/v1', '')}  ·  ${op.summary ?? ''}`.trim(),
        method.toUpperCase(),
        rawPath,
        {
          ...(hasBody && { body: EXAMPLES[key] ?? {} }),
          ...(op.security ? {} : { auth: noAuth }),
          query,
          description: op.description,
        },
      );
      if (!folders.has(tag)) folders.set(tag, []);
      folders.get(tag).push(item);
    }
  }
  return [...folders.entries()].map(([name, item]) => ({ name, item }));
}

// --- collection ---

const prerequest = [
  '// Money endpoints need an Idempotency-Key. A fresh one is added for every send;',
  '// set the collection variable fixedIdempotencyKey to reuse one (replay or 409 demo).',
  "const needsKey = pm.request.method === 'POST' && /\\/(wallet\\/fund|orders\\/checkout|payouts)$/.test(pm.request.url.getPath());",
  "if (needsKey && !pm.request.headers.has('Idempotency-Key')) {",
  "  const fixed = pm.collectionVariables.get('fixedIdempotencyKey');",
  "  pm.request.headers.add({ key: 'Idempotency-Key', value: fixed || pm.variables.replaceIn('{{$guid}}') });",
  '}',
  '// Today in Lagos time (UTC+1), for the revenue report.',
  "pm.collectionVariables.set('today', new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10));",
];

function build() {
  const spec = buildSpec();
  const variables = [
    ['baseUrl', 'http://localhost:3000'],
    ['fixedIdempotencyKey', ''],
    ...[
      'accessToken',
      'buyerToken',
      'vendorToken',
      'adminToken',
      'buyerId',
      'vendorId',
      'productId',
      'productSlug',
      'productPriceKobo',
      'fundingRef',
      'walletId',
      'cartItemId',
      'orderId',
      'subOrderId',
      'disputedSubOrderId',
      'disputeId',
      'notificationId',
      'today',
    ].map((k) => [k, '']),
  ];
  return {
    info: {
      name: 'KoboMarket API',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      description: [
        'Multi-vendor marketplace with wallets, a double-entry ledger and escrow. Money is integer kobo (NGN 1 = 100 kobo).',
        '',
        '1. Start the stack and load demo data: `docker compose up -d` then `docker compose exec api npm run seed`.',
        '2. Run **Demo flow** top to bottom (or with the Runner): each request saves the ids the next one needs.',
        '3. **All endpoints** has every operation from /api-docs.json, grouped like Swagger. They use {{accessToken}}, set by the last login.',
        '',
        `Demo password for every seeded account: ${DEMO_PASSWORD}`,
      ].join('\n'),
    },
    auth: bearer('accessToken'),
    event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: prerequest } }],
    variable: variables.map(([key, value]) => ({ key, value })),
    item: [
      {
        name: '1. Demo flow',
        description:
          'Fund → checkout → ship → confirm → payout, then a dispute with a partial refund, then the admin reports.',
        item: demoFlow,
      },
      { name: '2. All endpoints', item: allEndpoints(spec) },
    ],
  };
}

const serialize = () => `${JSON.stringify(build(), null, 2)}\n`;

if (require.main === module) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, serialize());
  const collection = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const count = (items) => items.reduce((n, x) => n + (x.item ? count(x.item) : 1), 0);
  console.log(
    `${path.relative(process.cwd(), OUT)}: ${count(collection.item[0].item)} demo requests, ${count(collection.item[1].item)} endpoints`,
  );
}

module.exports = { build, serialize, OUT };
