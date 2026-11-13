// Wallet reconciler, compensation retry and idempotency cleanup.
process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { LedgerService } = require('../../src/modules/ledger');
const { User } = require('../../src/modules/users/user.model');
const { Product } = require('../../src/modules/products/product.model');
const { Compensation } = require('../../src/modules/compensations/compensation.model');
const { runWalletReconciler } = require('../../src/jobs/wallet-reconciler');
const { runCompensationRetry, MAX_ATTEMPTS } = require('../../src/jobs/compensation-retry');
const { runIdempotencyCleanup } = require('../../src/jobs/idempotency-cleanup');
const { useMongo } = require('../helpers/mongo');
const { register } = require('../helpers/auth');
const { signInVendor } = require('../helpers/vendors');
const { makeProduct } = require('../helpers/products');

useMongo();
afterAll(() => postgres.close());

const app = createApp();

describe('wallet reconciler', () => {
  test('opens the wallet of a user left PENDING and marks them READY', async () => {
    const spy = jest
      .spyOn(LedgerService, 'openUserAccount')
      .mockRejectedValueOnce(new Error('Postgres down'));
    let userId;
    try {
      const { res } = await register(app);
      userId = res.body.data.user.id;
      expect(res.body.data.user.walletStatus).toBe('PENDING');
    } finally {
      spy.mockRestore();
    }
    expect(await LedgerService.findUserAccount(userId)).toBeNull();

    // Inside the grace period it is left alone (registration may still be running).
    await runWalletReconciler({ graceSeconds: 3600 });
    expect((await User.findById(userId)).walletStatus).toBe('PENDING');

    await runWalletReconciler({ graceSeconds: 0 });
    expect((await User.findById(userId)).walletStatus).toBe('READY');
    expect(await LedgerService.findUserAccount(userId)).toMatchObject({ balanceKobo: 0 });
  });
});

describe('compensation retry', () => {
  let vendor;
  beforeAll(async () => {
    vendor = await signInVendor(app);
    // Retire leftovers from earlier runs so each test sees only its own.
    await Compensation.updateMany({ status: 'PENDING' }, { $set: { status: 'DONE' } });
  });

  const stockOf = async (id) => (await Product.findById(id).lean()).stock;
  const record = (payload) =>
    Compensation.create({ type: 'STOCK_RELEASE', payload, reason: `test-${randomUUID()}` });

  test('puts the stock back and marks it DONE', async () => {
    const p = await makeProduct(app, vendor, { stock: 2 });
    const c = await record({ productId: p.id, variantSku: null, qty: 3 });
    await runCompensationRetry();
    expect(await stockOf(p.id)).toBe(5);
    expect((await Compensation.findById(c._id)).status).toBe('DONE');
  });

  test('two runs at once restock exactly once', async () => {
    const p = await makeProduct(app, vendor, { stock: 0 });
    await record({ productId: p.id, variantSku: null, qty: 4 });
    await Promise.all([runCompensationRetry(), runCompensationRetry()]);
    expect(await stockOf(p.id)).toBe(4);
  });

  test(`fails, retries later, and is DEAD after ${MAX_ATTEMPTS} attempts`, async () => {
    const c = await record({ productId: '0123456789abcdef01234567', variantSku: null, qty: 1 });
    await runCompensationRetry();
    let doc = await Compensation.findById(c._id);
    expect(doc).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'product not found' });

    // Backing off: an immediate second run leaves it alone.
    await runCompensationRetry();
    expect((await Compensation.findById(c._id)).attempts).toBe(1);

    await Compensation.updateOne(
      { _id: c._id },
      { $set: { attempts: MAX_ATTEMPTS - 1, claimedUntil: null } },
    );
    await runCompensationRetry();
    doc = await Compensation.findById(c._id);
    expect(doc).toMatchObject({ status: 'DEAD', attempts: MAX_ATTEMPTS });
  });
});

describe('idempotency cleanup', () => {
  test('deletes expired keys and keeps live ones', async () => {
    const user = `cleanup-${randomUUID()}`;
    await postgres.db('idempotency_keys').insert([
      {
        key: 'old',
        user_id: user,
        endpoint: 'x',
        request_hash: 'h',
        expires_at: postgres.db.raw("now() - interval '1 hour'"),
      },
      { key: 'new', user_id: user, endpoint: 'x', request_hash: 'h' },
    ]);
    await runIdempotencyCleanup();
    const left = await postgres.db('idempotency_keys').where({ user_id: user }).pluck('key');
    expect(left).toEqual(['new']);
  });
});
