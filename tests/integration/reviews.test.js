process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { Product } = require('../../src/modules/products/product.model');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');
const { signInVendor } = require('../helpers/vendors');
const { makeProduct } = require('../helpers/products');
const { fundedBuyer, addToCart, checkout } = require('../helpers/orders');

// Each test first completes a real order (checkout, ship, confirm): slow on a remote DB.
jest.setTimeout(120_000);

useMongo();
afterAll(() => postgres.close());

const app = createApp();
let vendor;
beforeAll(async () => {
  vendor = await signInVendor(app);
});

const review = (who, productId, body = { rating: 4, comment: 'Lovely fabric' }) =>
  request(app).post(`/api/v1/products/${productId}/reviews`).set(who.auth).send(body);

/** A buyer whose order for the product is COMPLETED (shipped and confirmed). */
async function buyerWhoReceived(product) {
  const buyer = await fundedBuyer(app, 2_000_000);
  await addToCart(app, buyer, product.id, 1);
  const sub = (await checkout(app, buyer)).body.data.order.subOrders[0];
  await request(app)
    .patch(`/api/v1/sub-orders/${sub.id}/ship`)
    .set(vendor.auth)
    .send({ courierName: 'GIG', trackingNumber: 'GIG-1' });
  await request(app).patch(`/api/v1/sub-orders/${sub.id}/confirm`).set(buyer.auth);
  return { buyer, sub };
}
const ratingOf = async (id) => (await Product.findById(id).lean()).rating;

describe('POST /products/:id/reviews', () => {
  test('a buyer with a completed order reviews; the product rating updates', async () => {
    const product = await makeProduct(app, vendor, { stock: 20 });
    const { buyer, sub } = await buyerWhoReceived(product);

    const res = await review(buyer, product.id, { rating: 4, comment: 'Lovely fabric' });
    expect(res.status).toBe(201);
    expect(res.body.data.review).toMatchObject({
      productId: product.id,
      buyerId: buyer.userId,
      subOrderId: sub.id,
      rating: 4,
      comment: 'Lovely fabric',
    });
    expect(res.body.data.productRating).toEqual({ avg: 4, count: 1 });

    const pub = await request(app).get(`/api/v1/products/${product.slug}`);
    expect(pub.body.data.product.rating).toEqual({ avg: 4, count: 1 });
  });

  test('one review per buyer per product', async () => {
    const product = await makeProduct(app, vendor, { stock: 20 });
    const { buyer } = await buyerWhoReceived(product);
    await review(buyer, product.id);
    const again = await review(buyer, product.id, { rating: 1 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_REVIEWED');
    expect(await ratingOf(product.id)).toMatchObject({ count: 1, avg: 4 });
  });

  test('no completed order means no review: never bought, or paid but not delivered', async () => {
    const product = await makeProduct(app, vendor, { stock: 20 });
    const stranger = await signIn(app);
    const res = await review(stranger, product.id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REVIEW_NOT_ALLOWED');

    const paidOnly = await fundedBuyer(app, 2_000_000);
    await addToCart(app, paidOnly, product.id, 1);
    await checkout(app, paidOnly);
    expect((await review(paidOnly, product.id)).status).toBe(403);
    expect(await ratingOf(product.id)).toMatchObject({ count: 0 });
  });

  test('a completed order for a different product does not count', async () => {
    const bought = await makeProduct(app, vendor, { stock: 20 });
    const other = await makeProduct(app, vendor, { stock: 20 });
    const { buyer } = await buyerWhoReceived(bought);
    expect((await review(buyer, other.id)).status).toBe(403);
  });

  test('ratings are whole stars from 1 to 5', async () => {
    const product = await makeProduct(app, vendor, { stock: 20 });
    const { buyer } = await buyerWhoReceived(product);
    for (const rating of [0, 6, 4.5, '5']) {
      expect((await review(buyer, product.id, { rating })).status).toBe(422);
    }
  });

  test('parallel reviews from different buyers: no vote is lost, the average is exact', async () => {
    const product = await makeProduct(app, vendor, { stock: 50 });
    const stars = [5, 4, 4, 3, 5, 1, 2, 5, 4, 3];
    const buyers = [];
    for (let i = 0; i < stars.length; i += 1) buyers.push((await buyerWhoReceived(product)).buyer);

    const results = await Promise.all(
      buyers.map((b, i) => review(b, product.id, { rating: stars[i] })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);

    const total = stars.reduce((a, b) => a + b, 0);
    const rating = await ratingOf(product.id);
    expect(rating).toMatchObject({
      count: 10,
      sum: total,
      avg: Math.round((total / 10) * 100) / 100,
    });
  }, 600_000);

  test('a deleted product cannot be reviewed', async () => {
    const product = await makeProduct(app, vendor, { stock: 20 });
    const { buyer } = await buyerWhoReceived(product);
    await request(app).delete(`/api/v1/products/${product.id}`).set(vendor.auth);
    expect((await review(buyer, product.id)).status).toBe(404);
  });
});
