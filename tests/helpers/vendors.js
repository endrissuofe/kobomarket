// A signed-in user with an APPROVED store, ready to manage products.
const { randomUUID } = require('node:crypto');
const { Vendor } = require('../../src/modules/vendors/vendor.model');
const { signIn } = require('./auth');

async function signInVendor(app, { status = 'APPROVED' } = {}) {
  const user = await signIn(app, { roles: ['buyer', 'vendor'] });
  const tag = randomUUID().slice(0, 8);
  const vendor = await Vendor.create({
    userId: user.userId,
    storeName: `Test Store ${tag}`,
    slug: `test-store-${tag}`,
    bank: { bankCode: '058', accountNumber: '0123456789', accountName: 'Test Vendor' },
    status,
  });
  return { ...user, vendorId: String(vendor._id) };
}

module.exports = { signInVendor };
