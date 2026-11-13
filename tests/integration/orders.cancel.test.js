process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { Product } = require('../../src/modules/products/product.model');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');
const { signInVendor } = require('../helpers/vendors');
const { makeProduct } = require('../helpers/products');
const { fundedBuyer, addToCart, checkout, balanceOf } = require('../helpers/orders');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
let vendorA;
let vendorB;
beforeAll(async () => {
  vendorA = await signInVendor(app);
  vendorB = await signInVendor(app);
});

const stockOf = async (id) => (await Product.findById(id).lean()).stock;
const cancel = (buyer, orderId) =>
  request(app).post(`/api/v1/orders/${orderId}/cancel`).set(buyer.auth);

/** A buyer with a 2-vendor PAID order. */
async function paidOrder() {
  const buyer = await fundedBuyer(app, 1_000_000);
  const a = await makeProduct(app, vendorA, { priceKobo: 200000, stock: 5 });
  const b = await makeProduct(app, vendorB, { priceKobo: 50000, stock: 5 });
  await addToCart(app, buyer, a.id, 2);
  await addToCart(app, buyer, b.id, 1);
  const order = (await checkout(app, buyer)).body.data.order;
  return { buyer, order, a, b };
}

describe('POST /orders/:id/cancel', () => {
  test('refunds the whole order from escrow, cancels every sub-order and restocks', async () => {
    const { buyer, order, a, b } = await paidOrder();
    expect(await balanceOf(buyer.accountId)).toBe(550000);

    const res = await cancel(buyer, order.id);
    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('CANCELLED');
    for (const sub of res.body.data.order.subOrders) {
      expect(sub.status).toBe('CANCELLED');
      expect(sub.refundTxnId).toEqual(expect.any(String));
    }

    expect(await balanceOf(buyer.accountId)).toBe(1_000_000);
    expect(await stockOf(a.id)).toBe(5);
    expect(await stockOf(b.id)).toBe(5);

    const refund = await postgres
      .db('transactions')
      .where({ reference: `ORD-${order.id}-CANCEL` })
      .first();
    expect(refund.type).toBe('REFUND');
    const history = await postgres
      .db('order_status_history')
      .where({ sub_order_id: order.subOrders[0].id })
      .orderBy('id');
    expect(history.at(-1)).toMatchObject({ from_status: 'PAID', to_status: 'CANCELLED' });
  });

  test('cancelling twice is a 409; the refund happens once', async () => {
    const { buyer, order } = await paidOrder();
    await cancel(buyer, order.id);
    const again = await cancel(buyer, order.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
    expect(await balanceOf(buyer.accountId)).toBe(1_000_000);
  });

  test('two cancels at once: one refund', async () => {
    const { buyer, order } = await paidOrder();
    const results = await Promise.all([cancel(buyer, order.id), cancel(buyer, order.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await balanceOf(buyer.accountId)).toBe(1_000_000);
  });

  test('if any sub-order has shipped, nothing is cancelled', async () => {
    const { buyer, order } = await paidOrder();
    await postgres.db('sub_orders').where({ id: order.subOrders[0].id }).update({
      status: 'SHIPPED',
      courier_name: 'GIG',
      tracking_number: 'T1',
      shipped_at: postgres.db.fn.now(),
    });

    const res = await cancel(buyer, order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
    const statuses = (await postgres.db('sub_orders').where({ order_id: order.id })).map(
      (s) => s.status,
    );
    expect(statuses.sort()).toEqual(['PAID', 'SHIPPED']);
    // Unchanged since checkout: 1,000,000 - 450,000 order total.
    expect(await balanceOf(buyer.accountId)).toBe(550000);
  });

  test("another buyer's order is a 404", async () => {
    const { order } = await paidOrder();
    const stranger = await signIn(app);
    expect((await cancel(stranger, order.id)).status).toBe(404);
  });
});
