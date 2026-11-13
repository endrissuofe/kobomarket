process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');
const { signInVendor } = require('../helpers/vendors');
const { makeProduct } = require('../helpers/products');
const { fundedBuyer, addToCart, checkout } = require('../helpers/orders');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
let vendorA;
let vendorB;
beforeAll(async () => {
  vendorA = await signInVendor(app);
  vendorB = await signInVendor(app);
});

async function placeOne(buyer, vendor = vendorA, priceKobo = 10000) {
  await addToCart(app, buyer, (await makeProduct(app, vendor, { priceKobo })).id, 1);
  const res = await checkout(app, buyer);
  expect(res.status).toBe(201);
  return res.body.data.order;
}

async function walk(path, auth, query = {}) {
  const items = [];
  let cursor;
  do {
    const res = await request(app)
      .get(path)
      .query({ ...query, ...(cursor && { cursor }) })
      .set(auth);
    expect(res.status).toBe(200);
    items.push(...res.body.data.items);
    cursor = res.body.data.nextCursor;
  } while (cursor);
  return items;
}

describe('GET /orders and GET /orders/:id', () => {
  test("lists the buyer's orders newest first, page by page, with sub-orders and items", async () => {
    const buyer = await fundedBuyer(app, 1_000_000);
    const placed = [];
    for (let i = 0; i < 5; i += 1) placed.push(await placeOne(buyer));

    const items = await walk('/api/v1/orders', buyer.auth, { limit: 2 });
    expect(items.map((o) => o.id)).toEqual(placed.map((o) => o.id).reverse());
    expect(items[0].subOrders[0].items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('cursorTime');
  }, 120_000);

  test('one order by id; another buyer gets 404', async () => {
    const buyer = await fundedBuyer(app, 100_000);
    const order = await placeOne(buyer);

    const mine = await request(app).get(`/api/v1/orders/${order.id}`).set(buyer.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.data.order).toMatchObject({ id: order.id, status: 'PAID', totalKobo: 10000 });

    const stranger = await signIn(app);
    expect((await request(app).get(`/api/v1/orders/${order.id}`).set(stranger.auth)).status).toBe(
      404,
    );
  });

  test('a malformed id is a 422 and a forged cursor a 400', async () => {
    const buyer = await signIn(app);
    expect((await request(app).get('/api/v1/orders/not-a-uuid').set(buyer.auth)).status).toBe(422);
    const cursor = Buffer.from(JSON.stringify({ t: "x'; drop table orders;--", id: 'y' })).toString(
      'base64url',
    );
    expect(
      (await request(app).get('/api/v1/orders').query({ cursor }).set(buyer.auth)).status,
    ).toBe(400);
  });
});

describe('GET /vendors/me/sub-orders', () => {
  test('a vendor sees only their own sub-orders, filterable by status', async () => {
    const vendor = await signInVendor(app);
    const buyer = await fundedBuyer(app, 1_000_000);
    // One order with lines from both this vendor and vendorB.
    await addToCart(app, buyer, (await makeProduct(app, vendor, { priceKobo: 30000 })).id, 2);
    await addToCart(app, buyer, (await makeProduct(app, vendorB, { priceKobo: 5000 })).id, 1);
    const order = (await checkout(app, buyer)).body.data.order;

    const subs = await walk('/api/v1/vendors/me/sub-orders', vendor.auth, { limit: 1 });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      orderId: order.id,
      vendorId: vendor.vendorId,
      status: 'PAID',
      subtotalKobo: 60000,
    });
    expect(subs[0].items[0]).toMatchObject({ qty: 2, unitPriceKobo: 30000 });

    expect(await walk('/api/v1/vendors/me/sub-orders', vendor.auth, { status: 'SHIPPED' })).toEqual(
      [],
    );
  });

  test('a buyer cannot list vendor sub-orders', async () => {
    const buyer = await signIn(app);
    expect((await request(app).get('/api/v1/vendors/me/sub-orders').set(buyer.auth)).status).toBe(
      403,
    );
  });
});
