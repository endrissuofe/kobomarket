// A signed-in user with an APPROVED store, ready to manage products.
const { randomUUID } = require('node:crypto');
const { Vendor } = require('../../src/modules/vendors/vendor.model');
const { signIn } = require('./auth');

async function signInVendor(app, { status = 'APPROVED', accountNumber = '0123456789' } = {}) {
  const user = await signIn(app, { roles: ['buyer', 'vendor'] });
  const tag = randomUUID().slice(0, 8);
  const vendor = await Vendor.create({
    userId: user.userId,
    storeName: `Test Store ${tag}`,
    slug: `test-store-${tag}`,
    bank: { bankCode: '058', accountNumber, accountName: 'Test Vendor' },
    status,
  });
  return { ...user, vendorId: String(vendor._id) };
}

/** A vendor whose wallet holds balanceKobo (funded through the ledger). */
async function fundedVendor(app, balanceKobo, opts) {
  const { LedgerService } = require('../../src/modules/ledger');
  const { fund } = require('./ledger');
  const vendor = await signInVendor(app, opts);
  const account = await LedgerService.openUserAccount(vendor.userId);
  if (balanceKobo > 0) await fund(account.id, balanceKobo);
  return { ...vendor, accountId: account.id };
}

module.exports = { signInVendor, fundedVendor };
