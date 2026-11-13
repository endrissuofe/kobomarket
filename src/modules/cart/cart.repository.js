const { Cart, MAX_CART_LINES, MAX_LINE_QTY } = require('./cart.model');

const sameLine = (productId, variantSku) => ({ productId, variantSku: variantSku ?? null });

// The only code that queries the carts collection.
const cartRepository = {
  findByUserId(userId) {
    return Cart.findOne({ userId }).lean();
  },

  /**
   * Add qty to an existing line for this product + variant, if there is one
   * and the new qty stays within the limit. Returns the cart, or null if no
   * such line exists (or the limit would be passed).
   */
  incrementLine(userId, { productId, variantSku, qty }) {
    return Cart.findOneAndUpdate(
      {
        userId,
        items: {
          $elemMatch: { ...sameLine(productId, variantSku), qty: { $lte: MAX_LINE_QTY - qty } },
        },
      },
      { $inc: { 'items.$.qty': qty } },
      { new: true },
    ).lean();
  },

  /**
   * Push a new line, creating the cart if needed, but only if the cart does
   * not already have this product + variant and has room. Atomic, so two
   * parallel adds of a new item cannot create two lines. Returns null when
   * the condition fails (the caller then retries as an increment).
   */
  async pushLine(userId, { productId, variantSku, qty, addedPriceKobo }) {
    try {
      return await Cart.findOneAndUpdate(
        {
          userId,
          items: { $not: { $elemMatch: sameLine(productId, variantSku) } },
          [`items.${MAX_CART_LINES - 1}`]: { $exists: false },
        },
        { $push: { items: { ...sameLine(productId, variantSku), qty, addedPriceKobo } } },
        { new: true, upsert: true },
      ).lean();
    } catch (err) {
      // The filter did not match an existing cart, so upsert tried to insert a
      // second cart for this user: the line exists or the cart is full.
      if (err.code === 11000) return null;
      throw err;
    }
  },

  setLineQty(userId, itemId, qty) {
    return Cart.findOneAndUpdate(
      { userId, 'items._id': itemId },
      { $set: { 'items.$.qty': qty } },
      { new: true },
    ).lean();
  },

  removeLine(userId, itemId) {
    return Cart.findOneAndUpdate(
      { userId, 'items._id': itemId },
      { $pull: { items: { _id: itemId } } },
      { new: true },
    ).lean();
  },

  findLine(userId, itemId) {
    return Cart.findOne({ userId, 'items._id': itemId }, { 'items.$': 1 }).lean();
  },
};

module.exports = { cartRepository };
