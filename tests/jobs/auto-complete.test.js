// Required test 12 and the rest of the auto-complete job.
process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { LedgerService } = require('../../src/modules/ledger');
const { runAutoComplete } = require('../../src/jobs/auto-complete');
const { useMongo } = require('../helpers/mongo');
const { signInVendor } = require('../helpers/vendors');
const { makeProduct } = require('../helpers/products');
const { fundedBuyer, addToCart, checkout } = require('../helpers/orders');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
let vendor;
beforeAll(async () => {
  vendor = await signInVendor(app);
});

/** A SHIPPED sub-order; overdue=true moves its auto-complete time into the past. */
async function shippedSubOrder({ overdue = true } = {}) {
  const buyer = await fundedBuyer(app, 500000);
  await addToCart(app, buyer, (await makeProduct(app, vendor, { priceKobo: 100000 })).id, 1);
  const sub = (await checkout(app, buyer)).body.data.order.subOrders[0];
  await request(app)
    .patch(`/api/v1/sub-orders/${sub.id}/ship`)
    .set(vendor.auth)
    .send({ courierName: 'GIG', trackingNumber: 'GIG-1' });
  if (overdue) {
    await postgres
      .db('sub_orders')
      .where({ id: sub.id })
      .update({ auto_complete_at: postgres.db.raw("now() - interval '1 minute'") });
  }
  return sub.id;
}
const statusOf = async (id) => (await postgres.db('sub_orders').where({ id }).first()).status;
const releases = (id) => postgres.db('transactions').where({ reference: `SUB-${id}-RELEASE` });

describe('auto-complete job', () => {
  // Required test 12
  test('a disputed sub-order is skipped, even when its timeout has passed', async () => {
    const id = await shippedSubOrder();
    // Disputes arrive in a later step; SHIPPED -> DISPUTED is a valid move.
    await postgres.db('sub_orders').where({ id }).update({ status: 'DISPUTED' });

    const result = await runAutoComplete();
    expect(result.completed).not.toContain(id);
    expect(await statusOf(id)).toBe('DISPUTED');
    expect(await releases(id)).toHaveLength(0);
  });

  test('an overdue SHIPPED sub-order completes and its escrow is released', async () => {
    const id = await shippedSubOrder();
    const result = await runAutoComplete();
    expect(result.completed).toContain(id);
    expect(await statusOf(id)).toBe('COMPLETED');
    expect(await releases(id)).toHaveLength(1);

    const last = await postgres
      .db('order_status_history')
      .where({ sub_order_id: id })
      .orderBy('id', 'desc')
      .first();
    expect(last).toMatchObject({
      from_status: 'SHIPPED',
      to_status: 'COMPLETED',
      actor_id: 'system',
    });
  });

  test('a sub-order not yet due is left alone', async () => {
    const id = await shippedSubOrder({ overdue: false });
    await runAutoComplete();
    expect(await statusOf(id)).toBe('SHIPPED');
  });

  test('two runs at once release the escrow exactly once', async () => {
    const id = await shippedSubOrder();
    await Promise.all([runAutoComplete(), runAutoComplete()]);
    expect(await statusOf(id)).toBe('COMPLETED');
    expect(await releases(id)).toHaveLength(1);
  });

  test('a buyer confirming while the job runs: still exactly one release', async () => {
    const id = await shippedSubOrder();
    const buyerId = (
      await postgres
        .db('orders')
        .join('sub_orders', 'sub_orders.order_id', 'orders.id')
        .where('sub_orders.id', id)
        .first('orders.buyer_id')
    ).buyer_id;
    const { ordersService } = require('../../src/modules/orders/orders.service');
    await Promise.allSettled([
      runAutoComplete(),
      ordersService.confirmDelivery({ id: buyerId }, id),
    ]);
    expect(await statusOf(id)).toBe('COMPLETED');
    expect(await releases(id)).toHaveLength(1);
  });

  test('the ledger audits clean after auto-complete', async () => {
    expect((await LedgerService.audit()).ok).toBe(true);
  });
});
