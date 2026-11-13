process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { useMongo } = require('../helpers/mongo');
const { signInVendor } = require('../helpers/vendors');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
let owner;
let rival;
beforeAll(async () => {
  owner = await signInVendor(app);
  rival = await signInVendor(app);
});

async function newProduct(overrides = {}) {
  const res = await request(app)
    .post('/api/v1/products')
    .set(owner.auth)
    .send({
      name: `Leather Sandal ${randomUUID().slice(0, 6)}`,
      category: 'shoes',
      priceKobo: 800000,
      stock: 10,
      ...overrides,
    });
  expect(res.status).toBe(201);
  return res.body.data.product;
}
const patch = (id, body, who = owner) =>
  request(app).patch(`/api/v1/products/${id}`).set(who.auth).send(body);
const del = (id, who = owner) => request(app).delete(`/api/v1/products/${id}`).set(who.auth);

describe('PATCH /products/:id', () => {
  test('the owner updates fields; the slug stays the same', async () => {
    const product = await newProduct();
    const res = await patch(product.id, { name: 'Renamed Sandal', priceKobo: 750000, stock: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data.product).toMatchObject({
      name: 'Renamed Sandal',
      priceKobo: 750000,
      stock: 3,
      slug: product.slug,
    });
  });

  test("another vendor's product is a 404 and is left unchanged", async () => {
    const product = await newProduct();
    const res = await patch(product.id, { priceKobo: 1 }, rival);
    expect(res.status).toBe(404);
    const pub = await request(app).get(`/api/v1/products/${product.slug}`);
    expect(pub.body.data.product.priceKobo).toBe(800000);
  });

  test('adding variants derives price and stock; then top-level price is refused', async () => {
    const product = await newProduct();
    const res = await patch(product.id, {
      variants: [
        { sku: 'SND-40', attrs: { size: '40' }, priceKobo: 820000, stock: 4 },
        { sku: 'SND-44', attrs: { size: '44' }, priceKobo: 790000, stock: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.product).toMatchObject({ priceKobo: 790000, stock: 5 });

    const refused = await patch(product.id, { priceKobo: 100 });
    expect(refused.status).toBe(422);
  });

  test('removing all variants needs a price and stock again', async () => {
    const product = await newProduct({
      priceKobo: undefined,
      stock: undefined,
      variants: [{ sku: 'X', priceKobo: 500, stock: 2 }],
    });
    expect((await patch(product.id, { variants: [] })).status).toBe(422);
    const ok = await patch(product.id, { variants: [], priceKobo: 600, stock: 9 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.product).toMatchObject({ variants: [], priceKobo: 600, stock: 9 });
  });

  test('deactivating hides it from the public; reactivating shows it again', async () => {
    const product = await newProduct();
    await patch(product.id, { isActive: false });
    expect((await request(app).get(`/api/v1/products/${product.slug}`)).status).toBe(404);
    await patch(product.id, { isActive: true });
    expect((await request(app).get(`/api/v1/products/${product.slug}`)).status).toBe(200);
  });

  test('an empty body, a decimal price, or an unknown field is a 422', async () => {
    const product = await newProduct();
    for (const body of [{}, { priceKobo: 10.5 }, { vendorId: rival.vendorId }]) {
      expect((await patch(product.id, body)).status).toBe(422);
    }
  });
});

describe('DELETE /products/:id', () => {
  test('soft deletes: hidden from the public, cannot be edited, second delete is 404', async () => {
    const product = await newProduct();
    expect((await del(product.id)).status).toBe(204);

    expect((await request(app).get(`/api/v1/products/${product.slug}`)).status).toBe(404);
    expect((await patch(product.id, { isActive: true })).status).toBe(404);
    expect((await del(product.id)).status).toBe(404);

    const { Product } = require('../../src/modules/products/product.model');
    const stored = await Product.findById(product.id);
    expect(stored.deletedAt).not.toBeNull();
    expect(stored.isActive).toBe(false);
  });

  test('another vendor cannot delete it', async () => {
    const product = await newProduct();
    expect((await del(product.id, rival)).status).toBe(404);
    expect((await request(app).get(`/api/v1/products/${product.slug}`)).status).toBe(200);
  });
});
