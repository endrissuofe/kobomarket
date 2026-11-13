const { cartRepository } = require('./cart.repository');
const { MAX_LINE_QTY } = require('./cart.model');
const { productsRepository } = require('../products/products.repository');
const { vendorsRepository } = require('../vendors/vendors.repository');
const { AppError, conflict, forbidden, notFound } = require('../../shared/errors');

// Problems a cart line can have. A cart with any problem is not ready to check out.
const LINE_PROBLEMS = Object.freeze({
  UNAVAILABLE: 'UNAVAILABLE', // deleted, inactive or variant removed
  PRICE_CHANGED: 'PRICE_CHANGED', // live price differs from the price when added
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  OWN_PRODUCT: 'OWN_PRODUCT', // the buyer now owns the store selling it
});

const unprocessable = (code, message, details) => new AppError(code, message, 422, details);

const isLive = (product) => product && product.isActive && !product.deletedAt;

/** The variant for a SKU, the product itself without variants, or null. */
function sellable(product, variantSku) {
  if (!product.variants?.length) {
    return variantSku ? null : { priceKobo: product.priceKobo, stock: product.stock };
  }
  return product.variants.find((v) => v.sku === variantSku) || null;
}

/** Id of the user's own store, if they have one (approved or not). */
async function ownStoreId(userId) {
  const store = await vendorsRepository.findByUserId(userId);
  return store ? String(store._id) : null;
}

/**
 * The cart checked against live products: current price, stock and any
 * problems per line, plus the subtotal at current prices. Checkout uses the
 * same review, so what the buyer sees is what checkout enforces.
 */
async function review(userId) {
  const cart = await cartRepository.findByUserId(userId);
  const lines = cart?.items ?? [];
  const [products, storeId] = await Promise.all([
    productsRepository.findByIds(lines.map((l) => l.productId)),
    ownStoreId(userId),
  ]);
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = lines.map((line) => {
    const product = byId.get(String(line.productId));
    const unit = product && isLive(product) ? sellable(product, line.variantSku) : null;
    const problems = [];
    if (!unit) problems.push(LINE_PROBLEMS.UNAVAILABLE);
    else {
      if (unit.priceKobo !== line.addedPriceKobo) problems.push(LINE_PROBLEMS.PRICE_CHANGED);
      if (unit.stock < line.qty) problems.push(LINE_PROBLEMS.INSUFFICIENT_STOCK);
    }
    if (product && storeId && String(product.vendorId) === storeId) {
      problems.push(LINE_PROBLEMS.OWN_PRODUCT);
    }
    return {
      id: String(line._id),
      productId: String(line.productId),
      variantSku: line.variantSku,
      qty: line.qty,
      name: product?.name ?? null,
      slug: product?.slug ?? null,
      vendorId: product ? String(product.vendorId) : null,
      image: product?.images?.[0] ?? null,
      addedPriceKobo: line.addedPriceKobo,
      unitPriceKobo: unit ? unit.priceKobo : null,
      lineTotalKobo: unit ? unit.priceKobo * line.qty : 0,
      availableStock: unit ? unit.stock : 0,
      problems,
    };
  });

  return {
    items,
    itemCount: items.reduce((n, i) => n + i.qty, 0),
    subtotalKobo: items.reduce((sum, i) => sum + i.lineTotalKobo, 0),
    ready: items.length > 0 && items.every((i) => i.problems.length === 0),
  };
}

/**
 * Add a product (and variant) to the cart, or add to its qty if it is there.
 * Stock is checked now as a courtesy; checkout reserves it for real.
 */
async function addItem(user, { productId, variantSku, qty }) {
  const product = await productsRepository.findLiveById(productId);
  if (!product) throw notFound('Product');

  if (String(product.vendorId) === (await ownStoreId(user.id))) {
    throw forbidden('You cannot buy from your own store', 'CANNOT_BUY_OWN_PRODUCT');
  }

  if (product.variants?.length && !variantSku) {
    throw unprocessable('VARIANT_REQUIRED', 'Choose a variant (variantSku) for this product', {
      variants: product.variants.map((v) => v.sku),
    });
  }
  const unit = sellable(product, variantSku);
  if (!unit) {
    throw unprocessable('UNKNOWN_VARIANT', 'This product has no such variant', { variantSku });
  }

  const cart = await cartRepository.findByUserId(user.id);
  const existing = cart?.items.find(
    (l) => String(l.productId) === String(productId) && l.variantSku === (variantSku ?? null),
  );
  const wanted = (existing?.qty ?? 0) + qty;
  if (wanted > MAX_LINE_QTY) {
    throw unprocessable('QTY_LIMIT', `At most ${MAX_LINE_QTY} of one item per order`);
  }
  if (wanted > unit.stock) {
    throw conflict('INSUFFICIENT_STOCK', 'Not enough stock', { available: unit.stock });
  }

  const line = { productId, variantSku, qty, addedPriceKobo: unit.priceKobo };
  // Increment if the line exists; else push; if a parallel add pushed it in
  // between, the push is refused and the increment now succeeds.
  const updated =
    (await cartRepository.incrementLine(user.id, line)) ??
    (await cartRepository.pushLine(user.id, line)) ??
    (await cartRepository.incrementLine(user.id, line));
  if (!updated) throw conflict('CART_FULL', 'Your cart is full; remove something first');

  return review(user.id);
}

/** Set a line's qty, checked against current stock. */
async function updateItem(user, itemId, { qty }) {
  const found = await cartRepository.findLine(user.id, itemId);
  const line = found?.items?.[0];
  if (!line) throw notFound('Cart item');

  const product = await productsRepository.findLiveById(line.productId);
  const unit = product && sellable(product, line.variantSku);
  if (!unit) {
    throw conflict('ITEM_UNAVAILABLE', 'This item is no longer for sale; remove it from your cart');
  }
  if (qty > unit.stock) {
    throw conflict('INSUFFICIENT_STOCK', 'Not enough stock', { available: unit.stock });
  }

  if (!(await cartRepository.setLineQty(user.id, itemId, qty))) throw notFound('Cart item');
  return review(user.id);
}

async function removeItem(user, itemId) {
  if (!(await cartRepository.removeLine(user.id, itemId))) throw notFound('Cart item');
  return review(user.id);
}

/** Store the live price on lines flagged PRICE_CHANGED (the buyer has now seen it). */
async function acceptPrices(userId, reviewedItems) {
  for (const item of reviewedItems) {
    if (item.problems.includes(LINE_PROBLEMS.PRICE_CHANGED) && item.unitPriceKobo !== null) {
      await cartRepository.setLinePrice(userId, item.id, item.unitPriceKobo);
    }
  }
}

function removeOrderedLines(userId, itemIds) {
  return cartRepository.removeLines(userId, itemIds);
}

module.exports = {
  cartService: { review, addItem, updateItem, removeItem, acceptPrices, removeOrderedLines },
  LINE_PROBLEMS,
};
