// npm run seed: demo data for the README quick start and the demo video.
//   1 admin, 3 approved vendors with 20 products, 5 buyers with funded wallets.
// Safe to run again: users, stores and products are found by email/slug and
// each buyer's funding has a fixed ledger reference, so nothing is created
// or credited twice. Refuses NODE_ENV=production.
const argon2 = require('argon2');

const config = require('../src/config');
const mongo = require('../src/db/mongo');
const postgres = require('../src/db/postgres');
const { usersRepository } = require('../src/modules/users/users.repository');
const { usersService } = require('../src/modules/users/users.service');
const { ROLES } = require('../src/modules/users/user.model');
const { vendorsRepository } = require('../src/modules/vendors/vendors.repository');
const { VENDOR_STATUS } = require('../src/modules/vendors/vendor.model');
const { productsRepository } = require('../src/modules/products/products.repository');
const { deriveFromVariants } = require('../src/modules/products/products.service');
const { LedgerService, SYSTEM_ACCOUNTS, TRANSACTION_TYPES } = require('../src/modules/ledger');
const { formatNaira } = require('../src/shared/money/kobo');
const data = require('../seeds/demo-data');

/** Find or create a verified user with these roles and an open wallet. */
async function ensureUser({ email, name }, roles, passwordHash) {
  let user = await usersRepository.findByEmail(email);
  if (!user) user = await usersRepository.create({ email, passwordHash, name });
  await usersRepository.markEmailVerified(user._id);
  for (const role of roles) await usersRepository.addRole(user._id, role);
  await usersService.provisionWallet(user._id);
  return usersRepository.findById(user._id);
}

async function ensureStore(user, store, adminId) {
  const existing = await vendorsRepository.findByUserId(user._id);
  if (existing) return existing;
  const created = await vendorsRepository.create({
    userId: user._id,
    ...store,
    status: VENDOR_STATUS.APPROVED,
    reviewedBy: adminId,
    reviewedAt: new Date(),
  });
  return created.toObject();
}

async function ensureProduct(store, product) {
  if (await productsRepository.slugExists(product.slug)) return false;
  await productsRepository.create(deriveFromVariants({ ...product, vendorId: store._id }));
  return true;
}

/** Credit the buyer once, from EXTERNAL_PAYSTACK, with a fixed reference. */
async function ensureFunding(user, amountKobo) {
  const wallet = await LedgerService.findUserAccount(String(user._id));
  const external = await LedgerService.getSystemAccount(SYSTEM_ACCOUNTS.EXTERNAL_PAYSTACK);
  try {
    await LedgerService.post({
      reference: `SEED-FUND-${user.email}`,
      type: TRANSACTION_TYPES.FUNDING,
      entries: [
        { accountId: external.id, direction: 'debit', amountKobo },
        { accountId: wallet.id, direction: 'credit', amountKobo },
      ],
      metadata: { source: 'seed' },
    });
    return true;
  } catch (err) {
    if (err.code === 'DUPLICATE_TRANSACTION') return false;
    throw err;
  }
}

async function seed({ log = console.log } = {}) {
  if (config.env === 'production' && process.env.SEED_ALLOW_PRODUCTION !== '1') {
    throw new Error('Refusing to seed demo data with NODE_ENV=production');
  }
  const passwordHash = await argon2.hash(data.DEMO_PASSWORD, { type: argon2.argon2id });

  const admin = await ensureUser(data.admin, [ROLES.ADMIN], passwordHash);

  let newProducts = 0;
  const stores = [];
  for (const v of data.vendors) {
    const user = await ensureUser(v, [ROLES.VENDOR], passwordHash);
    const store = await ensureStore(user, v.store, admin._id);
    for (const p of v.products) if (await ensureProduct(store, p)) newProducts += 1;
    stores.push({ user, store });
  }

  const funded = [];
  for (const b of data.buyers) {
    const user = await ensureUser(b, [], passwordHash);
    const credited = await ensureFunding(user, b.fundKobo);
    const wallet = await LedgerService.findUserAccount(String(user._id));
    funded.push({ user, credited, balanceKobo: wallet.balanceKobo });
  }

  log(`\nKoboMarket demo data (password for every account: ${data.DEMO_PASSWORD})\n`);
  log(`  admin   ${admin.email}`);
  for (const { user, store } of stores)
    log(`  vendor  ${user.email.padEnd(26)} ${store.storeName}`);
  for (const { user, balanceKobo } of funded) {
    log(`  buyer   ${user.email.padEnd(26)} wallet ${formatNaira(balanceKobo)}`);
  }
  log(
    `\n  ${newProducts} new products (${data.vendors.reduce((n, v) => n + v.products.length, 0)} in the demo set), ` +
      `${funded.filter((f) => f.credited).length} new wallet fundings.\n`,
  );

  return { admin, stores, buyers: funded, newProducts };
}

if (require.main === module) {
  (async () => {
    let code = 0;
    try {
      await mongo.connect();
      await seed();
    } catch (err) {
      console.error(`Seed failed: ${err.message}`);
      code = 1;
    } finally {
      await Promise.allSettled([mongo.close(), postgres.close()]);
    }
    process.exit(code);
  })();
}

module.exports = { seed };
