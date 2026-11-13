process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { Product } = require('../../src/modules/products/product.model');
const { User } = require('../../src/modules/users/user.model');
const { LedgerService } = require('../../src/modules/ledger');
const { useMongo } = require('../helpers/mongo');
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
const ordersOf = (buyer) => postgres.db('orders').where({ buyer_id: buyer.userId });
const cartOf = async (buyer) =>
  (await request(app).get('/api/v1/cart').set(buyer.auth)).body.data.cart;

describe('POST /orders/checkout', () => {
  test('a 2-vendor cart becomes 1 order, 2 PAID sub-orders and one escrow hold', async () => {
    const buyer = await fundedBuyer(app, 1_000_000);
    const bag = await makeProduct(app, vendorA, { priceKobo: 150000, stock: 5 });
    const shoe = await makeProduct(app, vendorB, { priceKobo: 200000, stock: 5 });
    await addToCart(app, buyer, bag.id, 2);
    await addToCart(app, buyer, shoe.id, 1);

    const escrow = await LedgerService.getSystemAccount('PLATFORM_ESCROW');
    const escrowBefore = escrow.balanceKobo;

    const res = await checkout(app, buyer);
    expect(res.status).toBe(201);
    const { order } = res.body.data;
    expect(order).toMatchObject({ totalKobo: 500000, status: 'PAID', buyerId: buyer.userId });
    expect(order.subOrders).toHaveLength(2);
    const byVendor = Object.fromEntries(order.subOrders.map((s) => [s.vendorId, s]));
    expect(byVendor[vendorA.vendorId]).toMatchObject({
      status: 'PAID',
      subtotalKobo: 300000,
      commissionBps: 500,
      vendorUserId: vendorA.userId,
    });
    expect(byVendor[vendorA.vendorId].items[0]).toMatchObject({
      productId: bag.id,
      unitPriceKobo: 150000,
      qty: 2,
      lineTotalKobo: 300000,
    });

    expect(await balanceOf(buyer.accountId)).toBe(500000);
    // Others may check out in parallel in CI, so assert at least our hold.
    expect((await LedgerService.getAccount(escrow.id)).balanceKobo).toBeGreaterThanOrEqual(
      escrowBefore + 500000,
    );
    const hold = await postgres
      .db('transactions')
      .where({ reference: `ORD-${order.id}` })
      .first();
    expect(hold.type).toBe('ESCROW_HOLD');

    expect(await stockOf(bag.id)).toBe(3);
    expect(await stockOf(shoe.id)).toBe(4);
    expect((await cartOf(buyer)).items).toEqual([]);

    const history = await postgres
      .db('order_status_history')
      .where({ sub_order_id: order.subOrders[0].id })
      .orderBy('id');
    expect(history.map((h) => [h.from_status, h.to_status])).toEqual([
      [null, 'PENDING_PAYMENT'],
      ['PENDING_PAYMENT', 'PAID'],
    ]);

    const outbox = await postgres
      .db('outbox_events')
      .where({ aggregate: 'order', aggregate_id: order.id })
      .first();
    expect(outbox).toMatchObject({ event_type: 'order.placed', status: 'PENDING' });
  });

  // Required test 6
  test('insufficient balance: no order, no ledger entries, stock untouched', async () => {
    const buyer = await fundedBuyer(app, 100000);
    const p = await makeProduct(app, vendorA, { priceKobo: 250000, stock: 4 });
    await addToCart(app, buyer, p.id, 1);

    const entriesBefore = await postgres
      .db('ledger_entries')
      .where({ account_id: buyer.accountId });

    const res = await checkout(app, buyer);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');

    expect(await ordersOf(buyer)).toHaveLength(0);
    const entriesAfter = await postgres.db('ledger_entries').where({ account_id: buyer.accountId });
    expect(entriesAfter).toHaveLength(entriesBefore.length);
    expect(await balanceOf(buyer.accountId)).toBe(100000);
    expect(await stockOf(p.id)).toBe(4);
    expect((await cartOf(buyer)).items).toHaveLength(1);
  });

  // Required test 8
  test('two buyers racing for the last item: exactly one gets it', async () => {
    const p = await makeProduct(app, vendorA, { priceKobo: 50000, stock: 1 });
    const one = await fundedBuyer(app, 100000);
    const two = await fundedBuyer(app, 100000);
    await addToCart(app, one, p.id, 1);
    await addToCart(app, two, p.id, 1);

    const results = await Promise.all([checkout(app, one), checkout(app, two)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(loser.body.error.code).toBe('OUT_OF_STOCK');

    expect(await stockOf(p.id)).toBe(0);
    const balances = [await balanceOf(one.accountId), await balanceOf(two.accountId)].sort(
      (a, b) => a - b,
    );
    expect(balances).toEqual([50000, 100000]);
  });

  // Required test 9
  test('the same Idempotency-Key twice creates one order and replays it', async () => {
    const buyer = await fundedBuyer(app, 500000);
    const p = await makeProduct(app, vendorA, { priceKobo: 40000, stock: 10 });
    await addToCart(app, buyer, p.id, 1);
    const key = randomUUID();

    const first = await checkout(app, buyer, key);
    // The cart is now empty, so only a replay can return 201 here.
    const second = await checkout(app, buyer, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.order.id).toBe(first.body.data.order.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await ordersOf(buyer)).toHaveLength(1);
    expect(await balanceOf(buyer.accountId)).toBe(460000);
  });

  test('the same Idempotency-Key sent 5 times at once still creates one order', async () => {
    const buyer = await fundedBuyer(app, 500000);
    const p = await makeProduct(app, vendorA, { priceKobo: 40000, stock: 10 });
    await addToCart(app, buyer, p.id, 1);
    const key = randomUUID();

    const results = await Promise.all(Array.from({ length: 5 }, () => checkout(app, buyer, key)));
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(await ordersOf(buyer)).toHaveLength(1);
    expect(await balanceOf(buyer.accountId)).toBe(460000);
  }, 60_000);

  test('a changed price stops checkout; the cart takes the new price and the retry succeeds', async () => {
    const buyer = await fundedBuyer(app, 500000);
    const p = await makeProduct(app, vendorA, { priceKobo: 100000, stock: 5 });
    await addToCart(app, buyer, p.id, 1);
    await Product.updateOne({ _id: p.id }, { $set: { priceKobo: 120000 } });

    const stale = await checkout(app, buyer);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'CART_NOT_READY',
      details: { items: [{ productId: p.id, problems: ['PRICE_CHANGED'], unitPriceKobo: 120000 }] },
    });
    expect(await stockOf(p.id)).toBe(5);

    const retry = await checkout(app, buyer);
    expect(retry.status).toBe(201);
    expect(retry.body.data.order.totalKobo).toBe(120000);
  });

  test('an empty cart is a 422; a frozen buyer is a 403', async () => {
    const empty = await fundedBuyer(app, 0);
    expect((await checkout(app, empty)).body.error.code).toBe('CART_EMPTY');

    const frozen = await fundedBuyer(app, 500000);
    await addToCart(app, frozen, (await makeProduct(app, vendorA)).id, 1);
    await User.updateOne({ _id: frozen.userId }, { $set: { status: 'FROZEN' } });
    const res = await checkout(app, frozen);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_FROZEN');
  });

  test('if the Postgres transaction fails, the reserved stock is put back', async () => {
    const buyer = await fundedBuyer(app, 500000);
    const p = await makeProduct(app, vendorA, { priceKobo: 10000, stock: 3 });
    await addToCart(app, buyer, p.id, 2);
    const spy = jest
      .spyOn(LedgerService, 'post')
      .mockRejectedValueOnce(new Error('connection reset'));
    try {
      expect((await checkout(app, buyer)).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await stockOf(p.id)).toBe(3);
    expect(await ordersOf(buyer)).toHaveLength(0);
    expect(await balanceOf(buyer.accountId)).toBe(500000);
  });

  test('checkout needs an Idempotency-Key', async () => {
    const buyer = await fundedBuyer(app, 0);
    const res = await request(app).post('/api/v1/orders/checkout').set(buyer.auth).send({});
    expect(res.status).toBe(400);
  });
});
