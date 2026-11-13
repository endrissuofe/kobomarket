const { productsRepository } = require('./products.repository');
const { vendorsRepository } = require('../vendors/vendors.repository');
const { VENDOR_STATUS } = require('../vendors/vendor.model');
const { createWithUniqueSlug } = require('../../shared/text/slug');
const { conflict, forbidden, notFound, validationError } = require('../../shared/errors');

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

/**
 * Partial update by the owning vendor. Another vendor's product is a 404, so
 * vendors cannot probe each other's catalogue.
 *
 * Stock is set to the absolute number sent. If a checkout decrements stock
 * between the vendor reading and saving, the vendor's number wins; this is a
 * known limitation (a delta endpoint using $inc would close it).
 */
async function update(user, productId, body) {
  const store = await approvedStoreOf(user);
  const current = await productsRepository.findOwned(productId, store._id);
  if (!current) throw notFound('Product');

  const variantsAfter = body.variants ?? current.variants;
  const sendsBase = body.priceKobo !== undefined || body.stock !== undefined;
  if (variantsAfter.length > 0 && sendsBase) {
    throw validationError({
      priceKobo: ['This product has variants; set price and stock on each variant'],
    });
  }
  if (body.variants?.length === 0 && (body.priceKobo === undefined || body.stock === undefined)) {
    throw validationError({ priceKobo: ['Removing all variants needs priceKobo and stock'] });
  }

  const set = body.variants?.length ? deriveFromVariants(body) : body;
  const updated = await productsRepository.updateOwned(productId, store._id, set);
  if (!updated) throw notFound('Product');
  return updated;
}

/** Soft delete: hidden everywhere, kept for order history. */
async function remove(user, productId) {
  const store = await approvedStoreOf(user);
  const deleted = await productsRepository.softDeleteOwned(productId, store._id);
  if (!deleted) throw notFound('Product');
}

module.exports = {
  productsService: { create, getBySlug, update, remove },
  approvedStoreOf,
  deriveFromVariants,
};
