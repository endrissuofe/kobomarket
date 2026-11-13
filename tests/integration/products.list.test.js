process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { Product } = require('../../src/modules/products/product.model');
const { useMongo } = require('../helpers/mongo');
const { signInVendor } = require('../helpers/vendors');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
let vendor;
let otherVendor;
beforeAll(async () => {
  vendor = await signInVendor(app);
  otherVendor = await signInVendor(app);
});

// Each test lists only its own category, so other tests' products never show.
const freshCategory = () => `cat-${randomUUID().slice(0, 8)}`;

async function make(category, overrides = {}, who = vendor) {
  const res = await request(app)
    .post('/api/v1/products')
    .set(who.auth)
    .send({
      name: `Item ${randomUUID().slice(0, 6)}`,
      category,
      priceKobo: 1000,
      stock: 1,
      ...overrides,
    });
  expect(res.status).toBe(201);
  return res.body.data.product;
}

/** Follow nextCursor to the end; return every item in order. */
async function walk(query, { path = '/api/v1/products', auth = {} } = {}) {
  const items = [];
  let cursor;
  let pages = 0;
  do {
    const res = await request(app)
      .get(path)
      .set(auth)
      .query({ ...query, ...(cursor && { cursor }) });
    expect(res.status).toBe(200);
    items.push(...res.body.data.items);
    cursor = res.body.data.nextCursor;
    pages += 1;
  } while (cursor && pages < 50);
  return items;
}

describe('GET /products sorting and cursor pagination', () => {
  test('price_asc walks every product once, ties broken by id', async () => {
    const category = freshCategory();
    const prices = [500, 300, 300, 300, 900, 300, 100];
    const made = [];
    for (const priceKobo of prices) made.push(await make(category, { priceKobo }));

    const items = await walk({ category, sort: 'price_asc', limit: 2 });
    expect(items.map((p) => p.priceKobo)).toEqual([...prices].sort((a, b) => a - b));
    expect(new Set(items.map((p) => p.id)).size).toBe(prices.length);

    const tied = items.filter((p) => p.priceKobo === 300).map((p) => p.id);
    expect(tied).toEqual([...tied].sort());
  });

  test('price_desc is the exact reverse order', async () => {
    const category = freshCategory();
    for (const priceKobo of [200, 200, 700, 50, 200]) await make(category, { priceKobo });
    const asc = await walk({ category, sort: 'price_asc', limit: 2 });
    const desc = await walk({ category, sort: 'price_desc', limit: 3 });
    expect(desc.map((p) => p.id)).toEqual(asc.map((p) => p.id).reverse());
  });

  test('newest first by default', async () => {
    const category = freshCategory();
    const made = [];
    for (let i = 0; i < 4; i += 1) made.push(await make(category));
    const items = await walk({ category, limit: 3 });
    expect(items.map((p) => p.id)).toEqual(made.map((p) => p.id).reverse());
  });

  test('rating sorts highest first, ties included', async () => {
    const category = freshCategory();
    const ratings = [4.5, 3, 4.5, 5, 0];
    for (const avg of ratings) {
      const p = await make(category);
      await Product.updateOne({ _id: p.id }, { $set: { 'rating.avg': avg, 'rating.count': 1 } });
    }
    const items = await walk({ category, sort: 'rating', limit: 2 });
    expect(items.map((p) => p.rating.avg)).toEqual([5, 4.5, 4.5, 3, 0]);
    expect(new Set(items.map((p) => p.id)).size).toBe(5);
  });

  test('a product added mid-walk does not cause repeats', async () => {
    const category = freshCategory();
    for (const priceKobo of [100, 200, 300, 400]) await make(category, { priceKobo });
    const first = await request(app)
      .get('/api/v1/products')
      .query({ category, sort: 'price_asc', limit: 2 });
    await make(category, { priceKobo: 150 }); // lands on the page already read
    const rest = await walk({
      category,
      sort: 'price_asc',
      limit: 2,
      cursor: first.body.data.nextCursor,
    });
    const ids = [...first.body.data.items, ...rest].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rest.map((p) => p.priceKobo)).toEqual([300, 400]);
  });

  test('a cursor from another sort, or a forged one, is a 400', async () => {
    const category = freshCategory();
    for (let i = 0; i < 3; i += 1) await make(category);
    const page = await request(app).get('/api/v1/products').query({ category, limit: 1 });
    const cursor = page.body.data.nextCursor;
    const wrongSort = await request(app)
      .get('/api/v1/products')
      .query({ category, sort: 'price_asc', cursor });
    expect(wrongSort.status).toBe(400);

    const forged = Buffer.from(JSON.stringify({ s: 'price_asc', id: 'x', v: 1 })).toString(
      'base64url',
    );
    const res = await request(app)
      .get('/api/v1/products')
      .query({ sort: 'price_asc', cursor: forged });
    expect(res.status).toBe(400);
  });
});

describe('GET /products filters and search', () => {
  test('price range, vendor and minimum rating filters', async () => {
    const category = freshCategory();
    const cheap = await make(category, { priceKobo: 100 });
    const mid = await make(category, { priceKobo: 500 });
    const dear = await make(category, { priceKobo: 900 });
    const theirs = await make(category, { priceKobo: 500 }, otherVendor);
    await Product.updateOne({ _id: dear.id }, { $set: { 'rating.avg': 4.2 } });

    const ids = async (q) => (await walk({ category, ...q })).map((p) => p.id).sort();

    expect(await ids({ minPrice: 200, maxPrice: 600 })).toEqual([mid.id, theirs.id].sort());
    expect(await ids({ maxPrice: 100 })).toEqual([cheap.id]);
    expect(await ids({ vendorId: otherVendor.vendorId })).toEqual([theirs.id]);
    expect(await ids({ minRating: 4 })).toEqual([dear.id]);
  });

  test('full-text search on name, tags and description, combined with a sort', async () => {
    const category = freshCategory();
    const word = `zq${randomUUID().slice(0, 6).replace(/-/g, '')}`;
    const byName = await make(category, { name: `Kente ${word} scarf`, priceKobo: 700 });
    const byTag = await make(category, { tags: [word], priceKobo: 300 });
    const byDescription = await make(category, {
      description: `Made with ${word} thread`,
      priceKobo: 500,
    });
    await make(category, { name: 'Unrelated mug' });

    const items = await walk({ q: word, category, sort: 'price_asc', limit: 2 });
    expect(items.map((p) => p.id)).toEqual([byTag.id, byDescription.id, byName.id]);
  });

  test('inactive and deleted products never appear', async () => {
    const category = freshCategory();
    const live = await make(category);
    await make(category, { isActive: false });
    const gone = await make(category);
    await request(app).delete(`/api/v1/products/${gone.id}`).set(vendor.auth);

    expect((await walk({ category })).map((p) => p.id)).toEqual([live.id]);
  });

  test.each([
    [{ minPrice: '10.5' }],
    [{ minPrice: 500, maxPrice: 100 }],
    [{ sort: 'cheapest' }],
    [{ limit: 1000 }],
    [{ vendorId: 'abc' }],
  ])('bad query %o is a 422', async (query) => {
    expect((await request(app).get('/api/v1/products').query(query)).status).toBe(422);
  });
});

describe('GET /vendors/me/products', () => {
  test("lists the vendor's own products, inactive included, deleted excluded", async () => {
    const me = await signInVendor(app);
    const a = await make('mine', {}, me);
    const b = await make('mine', { isActive: false }, me);
    const c = await make('mine', {}, me);
    await request(app).delete(`/api/v1/products/${c.id}`).set(me.auth);

    const items = await walk({ limit: 1 }, { path: '/api/v1/vendors/me/products', auth: me.auth });
    expect(items.map((p) => p.id)).toEqual([b.id, a.id]);
  });
});
