const { Schema, model } = require('mongoose');

const reviewSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // The completed Postgres sub-order that entitles the buyer to review.
    subOrderId: { type: String, required: true },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: { validator: Number.isInteger, message: 'Rating is a whole number of stars' },
    },
    comment: { type: String, trim: true, maxlength: 2000, default: '' },
  },
  { timestamps: true, collection: 'reviews' },
);

// One review per buyer per product.
reviewSchema.index({ productId: 1, buyerId: 1 }, { unique: true });
reviewSchema.index({ productId: 1, _id: -1 });

reviewSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = { Review: model('Review', reviewSchema) };
