const { Schema, model } = require('mongoose');

// Catalogue prices in integer kobo. This is a list price, not money: what a
// buyer actually paid is snapshotted into Postgres at checkout.
const kobo = {
  type: Number,
  required: true,
  min: 1,
  validate: { validator: Number.isSafeInteger, message: 'Price must be whole kobo' },
};
const count = {
  type: Number,
  required: true,
  min: 0,
  validate: { validator: Number.isSafeInteger, message: 'Stock must be a whole number' },
};

const variantSchema = new Schema(
  {
    sku: { type: String, required: true, trim: true },
    attrs: { type: Map, of: String, default: {} },
    priceKobo: kobo,
    stock: count,
  },
  { _id: false },
);

const productSchema = new Schema(
  {
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true },
    name: { type: String, required: true, trim: true, maxlength: 140 },
    slug: { type: String, required: true, unique: true },
    description: { type: String, trim: true, maxlength: 5000, default: '' },
    category: { type: String, required: true, trim: true, lowercase: true },
    // With variants: the lowest variant price ("from" price), kept in sync on
    // every write so filters and sorts work on one field.
    priceKobo: kobo,
    // With variants: the sum of variant stock. Checkout decrements both in
    // one $inc so they never drift.
    stock: count,
    variants: { type: [variantSchema], default: [] },
    tags: { type: [String], default: [] },
    images: { type: [String], default: [] },
    rating: {
      avg: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
    },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'products' },
);

productSchema.index(
  { name: 'text', description: 'text', tags: 'text' },
  { weights: { name: 5, tags: 3, description: 1 }, name: 'product_text' },
);
productSchema.index({ category: 1, priceKobo: 1, _id: 1 });
productSchema.index({ vendorId: 1, _id: -1 });
productSchema.index({ priceKobo: 1, _id: 1 });
productSchema.index({ 'rating.avg': -1, _id: -1 });

productSchema.set('toJSON', {
  flattenMaps: true,
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = { Product: model('Product', productSchema) };
