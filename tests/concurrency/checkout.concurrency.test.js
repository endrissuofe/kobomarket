// Required test 7 and the HTTP version of the same race.
process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { Product } = require('../../src/modules/products/product.model');
const { LedgerService } = require('../../src/modules/ledger');
const { ordersService } = require('../../src/modules/orders/orders.service');
const { useMongo } = require('../helpers/mongo');
const { signInVendor } = require('../helpers/vendors');
const { makeProduct } = require('../helpers/products');
const { fundedBuyer, addToCart, checkout, balanceOf } = require('../helpers/orders');

useMongo();
afterAll(() => postgres.close());

// Ten transactions queue on the same wallet and escrow rows; against a remote
// database each takes a few round trips, so allow time (see ledger races).
const RACE_TIMEOUT_MS = 120_000;
const PRICE = 100_000;

const app = createApp();
let vendor;
beforeAll(async () => {
  vendor = await signInVendor(app);
});

const stockOf = async (id) => (await Product.findById(id).lean()).stock;

// Required test 7
test(
  '10 concurrent checkouts against a wallet that can afford 3: exactly 3 succeed',
  async () => {
    const buyer = await fundedBuyer(app, 3 * PRICE + 50_000);
    const product = await makeProduct(app, vendor, { priceKobo: PRICE, stock: 100 });
    const line = {
      productId: product.id,
      variantSku: null,
      qty: 1,
      unitPriceKobo: PRICE,
      name: product.name,
      vendorId: vendor.vendorId,
    };
    const asBuyer = { id: buyer.userId, status: 'ACTIVE', walletStatus: 'READY' };

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => ordersService.placeOrder(asBuyer, [line])),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(3);
    expect(refused.map((r) => r.reason.code)).toEqual(Array(7).fill('INSUFFICIENT_FUNDS'));

    expect(await balanceOf(buyer.accountId)).toBe(50_000);
    const orders = await postgres.db('orders').where({ buyer_id: buyer.userId });
    expect(orders).toHaveLength(3);
    // The 7 refused checkouts gave their reserved stock back.
    expect(await stockOf(product.id)).toBe(97);
  },
  RACE_TIMEOUT_MS,
);

test(
  'over HTTP: 10 parallel checkouts of one cart never overspend or lose stock',
  async () => {
    const buyer = await fundedBuyer(app, 3 * PRICE);
    const product = await makeProduct(app, vendor, { priceKobo: PRICE, stock: 100 });
    await addToCart(app, buyer, product.id, 1);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => checkout(app, buyer, randomUUID())),
    );
    const created = results.filter((r) => r.status === 201);
    // Each request either placed an order, found the cart already emptied by
    // a finished one, or ran out of money; nothing else.
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(['CART_EMPTY', 'INSUFFICIENT_FUNDS']).toContain(r.body.error.code);
    }
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created.length).toBeLessThanOrEqual(3);

    const balance = await balanceOf(buyer.accountId);
    expect(balance).toBe(3 * PRICE - created.length * PRICE);
    expect(await stockOf(product.id)).toBe(100 - created.length);
  },
  RACE_TIMEOUT_MS,
);

test('the ledger audits clean after the checkout races', async () => {
  expect((await LedgerService.audit()).ok).toBe(true);
});
