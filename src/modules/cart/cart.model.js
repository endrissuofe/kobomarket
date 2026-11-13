const { Schema, model } = require('mongoose');

const MAX_CART_LINES = 50;
const MAX_LINE_QTY = 100;

// addedPriceKobo is the price the buyer saw when adding the line, kept only
// to flag "price changed". It is never charged: checkout reads live prices.
const cartItemSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  variantSku: { type: String, default: null },
  qty: { type: Number, required: true, min: 1, max: MAX_LINE_QTY },
  addedPriceKobo: { type: Number, required: true },
  addedAt: { type: Date, default: Date.now },
});

const cartSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    items: { type: [cartItemSchema], default: [] },
  },
  { timestamps: true, collection: 'carts' },
);

module.exports = { Cart: model('Cart', cartSchema), MAX_CART_LINES, MAX_LINE_QTY };
