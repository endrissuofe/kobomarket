process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { Product } = require('../../src/modules/products/product.model');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');
const { signInVendor } = require('../helpers/vendors');
const { makeProduct } = require('../helpers/products');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
let vendorA;
let vendorB;
beforeAll(async () => {
  vendorA = await signInVendor(app);
  vendorB = await signInVendor(app);
});

const add = (user, body) => request(app).post('/api/v1/cart/items').set(user.auth).send(body);
const getCart = async (user) =>
  (await request(app).get('/api/v1/cart').set(user.auth)).body.data.cart;

describe('POST /cart/items and GET /cart', () => {
  test('an empty cart', async () => {
    const buyer = await signIn(app);
    expect(await getCart(buyer)).toEqual({
      items: [],
      itemCount: 0,
      subtotalKobo: 0,
      ready: false,
    });
  });

  test('items from several vendors, with live prices and an integer subtotal', async () => {
    const buyer = await signIn(app);
    const bag = await makeProduct(app, vendorA, { priceKobo: 250000 });
    const shoe = await makeProduct(app, vendorB, {
      priceKobo: undefined,
      stock: undefined,
      variants: [{ sku: 'SHOE-42', attrs: { size: '42' }, priceKobo: 1999999, stock: 3 }],
    });

    expect((await add(buyer, { productId: bag.id, qty: 2 })).status).toBe(201);
    const res = await add(buyer, { productId: shoe.id, variantSku: 'SHOE-42' });
    expect(res.status).toBe(201);

    const { cart } = res.body.data;
    expect(cart.items).toHaveLength(2);
    expect(cart.items[0]).toMatchObject({
      productId: bag.id,
      vendorId: vendorA.vendorId,
      qty: 2,
      unitPriceKobo: 250000,
      lineTotalKobo: 500000,
      problems: [],
    });
    expect(cart.items[1]).toMatchObject({
      variantSku: 'SHOE-42',
      qty: 1,
      vendorId: vendorB.vendorId,
    });
    expect(cart.subtotalKobo).toBe(500000 + 1999999);
    expect(cart.itemCount).toBe(3);
    expect(cart.ready).toBe(true);
  });

  test('adding the same item again increases its qty instead of adding a line', async () => {
    const buyer = await signIn(app);
    const p = await makeProduct(app, vendorA);
    await add(buyer, { productId: p.id, qty: 1 });
    await add(buyer, { productId: p.id, qty: 2 });
    const cart = await getCart(buyer);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].qty).toBe(3);
  });

  test('parallel adds of a new item end up as one line with the total qty', async () => {
    const buyer = await signIn(app);
    const p = await makeProduct(app, vendorA, { stock: 50 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => add(buyer, { productId: p.id, qty: 1 })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const cart = await getCart(buyer);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].qty).toBe(5);
  });

  test('more than the stock is a 409 with the available amount', async () => {
    const buyer = await signIn(app);
    const p = await makeProduct(app, vendorA, { stock: 2 });
    await add(buyer, { productId: p.id, qty: 2 });
    const res = await add(buyer, { productId: p.id, qty: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { available: 2 } });
  });

  test('variant rules: required when the product has variants, must exist, refused when it has none', async () => {
    const buyer = await signIn(app);
    const withVariants = await makeProduct(app, vendorA, {
      priceKobo: undefined,
      stock: undefined,
      variants: [{ sku: 'V1', priceKobo: 100, stock: 5 }],
    });
    const plain = await makeProduct(app, vendorA);

    const missing = await add(buyer, { productId: withVariants.id });
    expect(missing.body.error).toMatchObject({
      code: 'VARIANT_REQUIRED',
      details: { variants: ['V1'] },
    });
    expect(
      (await add(buyer, { productId: withVariants.id, variantSku: 'NOPE' })).body.error.code,
    ).toBe('UNKNOWN_VARIANT');
    expect((await add(buyer, { productId: plain.id, variantSku: 'V1' })).body.error.code).toBe(
      'UNKNOWN_VARIANT',
    );
  });

  test('a vendor cannot add their own product', async () => {
    const p = await makeProduct(app, vendorA);
    const res = await add(vendorA, { productId: p.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANNOT_BUY_OWN_PRODUCT');
    // ...but can buy from another store.
    expect((await add(vendorA, { productId: (await makeProduct(app, vendorB)).id })).status).toBe(
      201,
    );
  });

  test('deleted, inactive or unknown products cannot be added', async () => {
    const buyer = await signIn(app);
    const inactive = await makeProduct(app, vendorA, { isActive: false });
    expect((await add(buyer, { productId: inactive.id })).status).toBe(404);
    expect((await add(buyer, { productId: '0123456789abcdef01234567' })).status).toBe(404);
  });

  test.each([[{ qty: 0 }], [{ qty: 1.5 }], [{ qty: 101 }], [{ productId: 'abc' }]])(
    'bad body %o is a 422',
    async (body) => {
      const buyer = await signIn(app);
      const p = await makeProduct(app, vendorA);
      expect((await add(buyer, { productId: p.id, ...body })).status).toBe(422);
    },
  );
});

describe('GET /cart flags stale lines', () => {
  test('price changed, out of stock, and deleted products are flagged; the cart is not ready', async () => {
    const buyer = await signIn(app);
    const repriced = await makeProduct(app, vendorA, { priceKobo: 100000 });
    const sellingOut = await makeProduct(app, vendorA, { stock: 5 });
    const removed = await makeProduct(app, vendorA);
    for (const p of [repriced, sellingOut, removed]) await add(buyer, { productId: p.id, qty: 2 });

    await Product.updateOne({ _id: repriced.id }, { $set: { priceKobo: 120000 } });
    await Product.updateOne({ _id: sellingOut.id }, { $set: { stock: 1 } });
    await request(app).delete(`/api/v1/products/${removed.id}`).set(vendorA.auth);

    const cart = await getCart(buyer);
    const byId = Object.fromEntries(cart.items.map((i) => [i.productId, i]));
    expect(byId[repriced.id]).toMatchObject({
      addedPriceKobo: 100000,
      unitPriceKobo: 120000,
      lineTotalKobo: 240000,
      problems: ['PRICE_CHANGED'],
    });
    expect(byId[sellingOut.id]).toMatchObject({
      availableStock: 1,
      problems: ['INSUFFICIENT_STOCK'],
    });
    expect(byId[removed.id]).toMatchObject({
      unitPriceKobo: null,
      lineTotalKobo: 0,
      problems: ['UNAVAILABLE'],
    });
    expect(cart.ready).toBe(false);
  });

  test('each user sees only their own cart', async () => {
    const one = await signIn(app);
    const two = await signIn(app);
    await add(one, { productId: (await makeProduct(app, vendorA)).id });
    expect((await getCart(two)).items).toEqual([]);
  });
});

describe('PATCH and DELETE /cart/items/:itemId', () => {
  const patch = (user, itemId, body) =>
    request(app).patch(`/api/v1/cart/items/${itemId}`).set(user.auth).send(body);
  const del = (user, itemId) => request(app).delete(`/api/v1/cart/items/${itemId}`).set(user.auth);

  async function cartWithOne(stock = 10) {
    const buyer = await signIn(app);
    const p = await makeProduct(app, vendorA, { stock, priceKobo: 30000 });
    const { cart } = (await add(buyer, { productId: p.id, qty: 1 })).body.data;
    return { buyer, product: p, itemId: cart.items[0].id };
  }

  test('sets the qty and returns the reviewed cart', async () => {
    const { buyer, itemId } = await cartWithOne();
    const res = await patch(buyer, itemId, { qty: 4 });
    expect(res.status).toBe(200);
    expect(res.body.data.cart).toMatchObject({ itemCount: 4, subtotalKobo: 120000 });
  });

  test('more than the stock is a 409', async () => {
    const { buyer, itemId } = await cartWithOne(3);
    const res = await patch(buyer, itemId, { qty: 4 });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ available: 3 });
  });

  test('a line whose product was deleted cannot be changed, only removed', async () => {
    const { buyer, product, itemId } = await cartWithOne();
    await request(app).delete(`/api/v1/products/${product.id}`).set(vendorA.auth);
    expect((await patch(buyer, itemId, { qty: 2 })).body.error.code).toBe('ITEM_UNAVAILABLE');

    const res = await del(buyer, itemId);
    expect(res.status).toBe(200);
    expect(res.body.data.cart.items).toEqual([]);
  });

  test("another user's line is a 404 and stays put", async () => {
    const { buyer, itemId } = await cartWithOne();
    const intruder = await signIn(app);
    expect((await patch(intruder, itemId, { qty: 2 })).status).toBe(404);
    expect((await del(intruder, itemId)).status).toBe(404);
    expect((await getCart(buyer)).items).toHaveLength(1);
  });

  test('removing twice is a 404 the second time', async () => {
    const { buyer, itemId } = await cartWithOne();
    expect((await del(buyer, itemId)).status).toBe(200);
    expect((await del(buyer, itemId)).status).toBe(404);
  });

  test('qty 0 or a decimal is a 422 (use DELETE to remove)', async () => {
    const { buyer, itemId } = await cartWithOne();
    expect((await patch(buyer, itemId, { qty: 0 })).status).toBe(422);
    expect((await patch(buyer, itemId, { qty: 2.5 })).status).toBe(422);
  });
});
