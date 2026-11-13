const { productsRepository } = require('./products.repository');
const { vendorsRepository } = require('../vendors/vendors.repository');
const { VENDOR_STATUS } = require('../vendors/vendor.model');
const { createWithUniqueSlug } = require('../../shared/text/slug');
const { conflict, forbidden, notFound } = require('../../shared/errors');

/**
 * The caller's store. The vendor role is only granted on approval, but the
 * store is checked too so a later status change is respected.
 */
async function approvedStoreOf(user) {
  const vendor = await vendorsRepository.findByUserId(user.id);
  if (!vendor || vendor.status !== VENDOR_STATUS.APPROVED) {
    throw forbidden('Your store is not approved', 'VENDOR_NOT_APPROVED');
  }
  return vendor;
}

/** With variants: price is the lowest variant price, stock the total. */
function deriveFromVariants(fields) {
  if (!fields.variants?.length) return fields;
  return {
    ...fields,
    priceKobo: Math.min(...fields.variants.map((v) => v.priceKobo)),
    stock: fields.variants.reduce((sum, v) => sum + v.stock, 0),
  };
}

async function create(user, body) {
  const store = await approvedStoreOf(user);
  const fields = deriveFromVariants({ ...body, vendorId: store._id });
  try {
    return await createWithUniqueSlug(body.name, {
      exists: (slug) => productsRepository.slugExists(slug),
      create: (slug) => productsRepository.create({ ...fields, slug }),
    });
  } catch (err) {
    if (err.code === 'SLUG_UNAVAILABLE') {
      throw conflict('SLUG_UNAVAILABLE', 'Could not pick a unique product URL; try another name');
    }
    throw err;
  }
}

async function getBySlug(slug) {
  const product = await productsRepository.findLiveBySlug(slug);
  if (!product) throw notFound('Product');
  return product;
}

module.exports = {
  productsService: { create, getBySlug },
  approvedStoreOf,
  deriveFromVariants,
};
