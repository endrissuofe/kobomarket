const { productsRepository, LIVE } = require('./products.repository');
const { decodeCursor, paginate } = require('../../shared/http/cursor');
const { objectId } = require('../../shared/http/schemas');
const { vendorsRepository } = require('../vendors/vendors.repository');
const { VENDOR_STATUS } = require('../vendors/vendor.model');
const { createWithUniqueSlug } = require('../../shared/text/slug');
const {
  badRequest,
  conflict,
  forbidden,
  notFound,
  validationError,
} = require('../../shared/errors');

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

// --- Listing ---

// Each sort is one field plus _id as the tie-break, so the order is total and
// a cursor (last value, last _id) resumes exactly where the page ended:
// equal prices or ratings never repeat or get skipped.
const SORTS = {
  newest: { field: null, dir: -1 },
  price_asc: { field: 'priceKobo', dir: 1 },
  price_desc: { field: 'priceKobo', dir: -1 },
  rating: { field: 'rating.avg', dir: -1 },
};

const valueAt = (doc, path) => path.split('.').reduce((v, key) => v?.[key], doc);

function keysetCondition({ field, dir }, cursor) {
  const op = dir === 1 ? '$gt' : '$lt';
  if (!field) return { _id: { [op]: cursor.id } };
  return {
    $or: [{ [field]: { [op]: cursor.v } }, { [field]: cursor.v, _id: { [op]: cursor.id } }],
  };
}

/** Decode a cursor and check it belongs to this sort and is well formed. */
function readCursor(raw, sortName) {
  const cursor = decodeCursor(raw);
  if (!cursor) return null;
  const valid =
    cursor.s === sortName &&
    objectId.safeParse(cursor.id).success &&
    (SORTS[sortName].field === null || typeof cursor.v === 'number');
  if (!valid) throw badRequest('Invalid cursor for this sort');
  return cursor;
}

async function listPage(baseFilter, { sort: sortName, limit, cursor: rawCursor }) {
  const sort = SORTS[sortName];
  const cursor = readCursor(rawCursor, sortName);
  const filter = cursor ? { $and: [baseFilter, keysetCondition(sort, cursor)] } : baseFilter;
  const order = sort.field ? { [sort.field]: sort.dir, _id: sort.dir } : { _id: sort.dir };

  const rows = await productsRepository.find({ filter, sort: order, limit: limit + 1 });
  return paginate(rows, limit, (doc) => ({
    s: sortName,
    id: String(doc._id),
    ...(sort.field && { v: valueAt(doc, sort.field) }),
  }));
}

/**
 * Public catalogue: full-text search on name, tags and description; filters
 * on category, price range, vendor and rating. Search narrows the results;
 * the order is always the chosen sort (a relevance score cannot be a cursor).
 */
function list(query) {
  const filter = { ...LIVE };
  if (query.q) filter.$text = { $search: query.q };
  if (query.category) filter.category = query.category;
  if (query.vendorId) filter.vendorId = query.vendorId;
  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    filter.priceKobo = {
      ...(query.minPrice !== undefined && { $gte: query.minPrice }),
      ...(query.maxPrice !== undefined && { $lte: query.maxPrice }),
    };
  }
  if (query.minRating !== undefined) filter['rating.avg'] = { $gte: query.minRating };
  return listPage(filter, query);
}

/** The vendor's own catalogue, including inactive products (not deleted ones). */
async function listMine(user, query) {
  const store = await approvedStoreOf(user);
  return listPage({ vendorId: store._id, deletedAt: null }, query);
}

module.exports = {
  productsService: { create, getBySlug, update, remove, list, listMine },
  approvedStoreOf,
  deriveFromVariants,
};
