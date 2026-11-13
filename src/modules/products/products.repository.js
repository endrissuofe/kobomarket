const { Product } = require('./product.model');

// Shown to the public: active and not soft-deleted.
const LIVE = { isActive: true, deletedAt: null };

// The only code that queries the products collection.
const productsRepository = {
  create(fields) {
    return Product.create(fields);
  },

  slugExists(slug) {
    return Product.exists({ slug });
  },

  findLiveById(id) {
    return Product.findOne({ _id: id, ...LIVE }).lean();
  },

  /** Any products by id, deleted or inactive included (callers flag those). */
  findByIds(ids) {
    return Product.find({ _id: { $in: ids } }).lean();
  },

  findLiveBySlug(slug) {
    return Product.findOne({ slug, ...LIVE });
  },

  /** A product owned by this vendor that is not deleted (inactive is fine). */
  findOwned(id, vendorId) {
    return Product.findOne({ _id: id, vendorId, deletedAt: null });
  },

  updateOwned(id, vendorId, set) {
    return Product.findOneAndUpdate(
      { _id: id, vendorId, deletedAt: null },
      { $set: set },
      { new: true, runValidators: true },
    );
  },

  softDeleteOwned(id, vendorId, now = new Date()) {
    return Product.findOneAndUpdate(
      { _id: id, vendorId, deletedAt: null },
      { $set: { deletedAt: now, isActive: false } },
      { new: true },
    );
  },

  /**
   * One page of a listing. The service builds filter (including the keyset
   * condition from the cursor) and sort. Returns documents, so toJSON applies.
   */
  find({ filter, sort, limit }) {
    return Product.find(filter).sort(sort).limit(limit);
  },
};

module.exports = { productsRepository, LIVE };
