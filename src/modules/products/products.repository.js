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
   * Take qty off stock if, and only if, that much is available. One atomic
   * conditional update: two buyers racing for the last item cannot both
   * succeed. A variant line updates the variant and the product total
   * together. Returns true if reserved.
   */
  async reserveStock({ productId, variantSku, qty }) {
    const res = variantSku
      ? await Product.updateOne(
          {
            _id: productId,
            ...LIVE,
            variants: { $elemMatch: { sku: variantSku, stock: { $gte: qty } } },
          },
          { $inc: { 'variants.$.stock': -qty, stock: -qty } },
        )
      : await Product.updateOne(
          { _id: productId, ...LIVE, 'variants.0': { $exists: false }, stock: { $gte: qty } },
          { $inc: { stock: -qty } },
        );
    return res.modifiedCount === 1;
  },

  /**
   * Add one star rating, atomically: a single pipeline update adds to sum and
   * count and recomputes avg from them, so parallel reviews never lose a vote
   * (no read-modify-write in JS). Returns the updated rating.
   */
  async addRating(productId, stars) {
    const sum = { $add: [{ $ifNull: ['$rating.sum', 0] }, stars] };
    const count = { $add: [{ $ifNull: ['$rating.count', 0] }, 1] };
    const doc = await Product.findOneAndUpdate(
      { _id: productId },
      [
        {
          $set: {
            'rating.sum': sum,
            'rating.count': count,
            'rating.avg': { $round: [{ $divide: [sum, count] }, 2] },
          },
        },
      ],
      { new: true, projection: { rating: 1 } },
    ).lean();
    return doc?.rating ?? null;
  },

  /** A product that exists and is not deleted (inactive is fine for reviews). */
  findNotDeleted(id) {
    return Product.findOne({ _id: id, deletedAt: null }).lean();
  },

  /** Put qty back (cancel or compensation). Works on deleted products too. */
  async releaseStock({ productId, variantSku, qty }) {
    const res = variantSku
      ? await Product.updateOne(
          { _id: productId, 'variants.sku': variantSku },
          { $inc: { 'variants.$.stock': qty, stock: qty } },
        )
      : await Product.updateOne({ _id: productId }, { $inc: { stock: qty } });
    return res.matchedCount === 1;
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
