process.env.NODE_ENV = 'test';

const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { Product } = require('../../src/modules/products/product.model');
const { Compensation } = require('../../src/modules/compensations/compensation.model');
const { productsRepository } = require('../../src/modules/products/products.repository');
const { stockService } = require('../../src/modules/products/stock.service');
const { useMongo } = require('../helpers/mongo');
const { signInVendor } = require('../helpers/vendors');
const { makeProduct } = require('../helpers/products');

useMongo();
afterAll(() => postgres.close());

const app = createApp();
let vendor;
beforeAll(async () => {
  vendor = await signInVendor(app);
});

const stockOf = async (id) => (await Product.findById(id).lean()).stock;
const line = (p, qty, variantSku = null) => ({ productId: p.id, variantSku, qty });

describe('stockService.reserve / release', () => {
  test('reserves and releases a plain product', async () => {
    const p = await makeProduct(app, vendor, { stock: 5 });
    await stockService.reserve([line(p, 3)], 'test');
    expect(await stockOf(p.id)).toBe(2);
    await stockService.release([line(p, 3)], 'test');
    expect(await stockOf(p.id)).toBe(5);
  });

  test('a variant line moves the variant stock and the product total together', async () => {
    const p = await makeProduct(app, vendor, {
      priceKobo: undefined,
      stock: undefined,
      variants: [
        { sku: 'A', priceKobo: 100, stock: 4 },
        { sku: 'B', priceKobo: 100, stock: 6 },
      ],
    });
    await stockService.reserve([line(p, 3, 'B')], 'test');
    const after = await Product.findById(p.id).lean();
    expect(after.stock).toBe(7);
    expect(after.variants.map((v) => v.stock)).toEqual([4, 3]);
  });

  test('all or nothing: a short line releases the lines already reserved', async () => {
    const plenty = await makeProduct(app, vendor, { stock: 10 });
    const scarce = await makeProduct(app, vendor, { stock: 1 });
    await expect(
      stockService.reserve([line(plenty, 4), line(scarce, 2)], 'test'),
    ).rejects.toMatchObject({ code: 'OUT_OF_STOCK', details: { productId: scarce.id } });
    expect(await stockOf(plenty.id)).toBe(10);
    expect(await stockOf(scarce.id)).toBe(1);
  });

  test('two reservations racing for the last item: exactly one wins', async () => {
    const p = await makeProduct(app, vendor, { stock: 1 });
    const results = await Promise.allSettled([
      stockService.reserve([line(p, 1)], 'a'),
      stockService.reserve([line(p, 1)], 'b'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await stockOf(p.id)).toBe(0);
  });

  test('a deleted product cannot be reserved', async () => {
    const p = await makeProduct(app, vendor, { stock: 5 });
    await Product.updateOne({ _id: p.id }, { $set: { deletedAt: new Date(), isActive: false } });
    await expect(stockService.reserve([line(p, 1)], 'test')).rejects.toMatchObject({
      code: 'OUT_OF_STOCK',
    });
  });

  test('a release that fails is recorded as a compensation, not lost', async () => {
    const p = await makeProduct(app, vendor, { stock: 5 });
    const reason = `test-${Date.now()}`;
    const spy = jest
      .spyOn(productsRepository, 'releaseStock')
      .mockRejectedValueOnce(new Error('mongo blip'));
    try {
      await stockService.release([line(p, 2)], reason);
    } finally {
      spy.mockRestore();
    }
    const saved = await Compensation.findOne({ reason }).lean();
    expect(saved).toMatchObject({
      type: 'STOCK_RELEASE',
      status: 'PENDING',
      payload: { productId: p.id, qty: 2 },
      lastError: 'mongo blip',
    });
  });
});
