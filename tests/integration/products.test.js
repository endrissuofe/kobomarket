process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');
const { signInVendor } = require('../helpers/vendors');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
let vendor;
beforeAll(async () => {
  vendor = await signInVendor(app);
});

const simple = (overrides = {}) => ({
  name: `Ankara Tote ${randomUUID().slice(0, 6)}`,
  description: 'Hand-sewn tote bag',
  category: 'Bags',
  priceKobo: 1250000,
  stock: 7,
  tags: ['Ankara', 'tote'],
  images: ['https://img.example.com/tote.jpg'],
  ...overrides,
});
const create = (body, who = vendor) =>
  request(app).post('/api/v1/products').set(who.auth).send(body);

describe('POST /products', () => {
  test('a vendor creates a product; it is public by slug', async () => {
    const body = simple();
    const res = await create(body);

    expect(res.status).toBe(201);
    const { product } = res.body.data;
    expect(product).toMatchObject({
      vendorId: vendor.vendorId,
      category: 'bags',
      priceKobo: 1250000,
      stock: 7,
      tags: ['ankara', 'tote'],
      isActive: true,
      deletedAt: null,
      rating: { avg: 0, count: 0 },
    });
    expect(product.slug).toMatch(/^ankara-tote-/);

    const pub = await request(app).get(`/api/v1/products/${product.slug}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.product.id).toBe(product.id);
  });

  test('with variants, price is the lowest variant price and stock the total', async () => {
    const res = await create(
      simple({
        priceKobo: undefined,
        stock: undefined,
        variants: [
          { sku: 'TOTE-S', attrs: { size: 'S' }, priceKobo: 900000, stock: 2 },
          { sku: 'TOTE-L', attrs: { size: 'L', colour: 'red' }, priceKobo: 1500000, stock: 5 },
        ],
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.product).toMatchObject({ priceKobo: 900000, stock: 7 });
    expect(res.body.data.product.variants[1].attrs).toEqual({ size: 'L', colour: 'red' });
  });

  test.each([
    ['a decimal price', { priceKobo: 1250.5 }, 'priceKobo'],
    ['a price sent as a string', { priceKobo: '1250000' }, 'priceKobo'],
    ['a zero price', { priceKobo: 0 }, 'priceKobo'],
    ['negative stock', { stock: -1 }, 'stock'],
    ['no price and no variants', { priceKobo: undefined }, 'priceKobo'],
    ['an image that is not a URL', { images: ['not a url'] }, 'images'],
    ['an unknown field (rating cannot be set)', { rating: { avg: 5, count: 1000 } }, '_form'],
  ])('rejects %s with 422', async (_label, overrides, field) => {
    const res = await create(simple(overrides));
    expect(res.status).toBe(422);
    expect(res.body.error.details).toHaveProperty(field);
  });

  test('variant rules: duplicate SKUs, decimal variant price, and top-level price alongside variants', async () => {
    const variants = [
      { sku: 'A', priceKobo: 100, stock: 1 },
      { sku: 'A', priceKobo: 200, stock: 1 },
    ];
    const dup = await create(simple({ priceKobo: undefined, stock: undefined, variants }));
    expect(dup.status).toBe(422);

    const decimal = await create(
      simple({
        priceKobo: undefined,
        stock: undefined,
        variants: [{ sku: 'A', priceKobo: 99.99, stock: 1 }],
      }),
    );
    expect(decimal.status).toBe(422);

    const both = await create(simple({ variants: [{ sku: 'A', priceKobo: 100, stock: 1 }] }));
    expect(both.status).toBe(422);
    expect(both.body.error.details).toHaveProperty('priceKobo');
  });

  test('two products with the same name get different slugs', async () => {
    const name = `Same Product ${randomUUID().slice(0, 6)}`;
    const a = await create(simple({ name }));
    const b = await create(simple({ name }));
    expect(a.body.data.product.slug).not.toBe(b.body.data.product.slug);
  });

  test('a vendor whose store is not approved is refused', async () => {
    const pending = await signInVendor(app, { status: 'PENDING' });
    const res = await create(simple(), pending);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('VENDOR_NOT_APPROVED');
  });

  test('a buyer is refused', async () => {
    const buyer = await signIn(app);
    expect((await create(simple(), buyer)).status).toBe(403);
  });
});

describe('GET /products/:slug', () => {
  test('an inactive product is not public', async () => {
    const { product } = (await create(simple({ isActive: false }))).body.data;
    expect((await request(app).get(`/api/v1/products/${product.slug}`)).status).toBe(404);
  });

  test('an unknown slug is 404', async () => {
    expect((await request(app).get('/api/v1/products/no-such-product-xyz')).status).toBe(404);
  });
});
