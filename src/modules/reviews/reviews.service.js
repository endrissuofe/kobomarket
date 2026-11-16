const { db } = require('../../db/postgres');
const { conflict, forbidden, notFound } = require('../../shared/errors');
const { logger } = require('../../shared/logger');
const { productsRepository } = require('../products/products.repository');
const { ordersRepository } = require('../orders/orders.repository');
const { reviewsRepository } = require('./reviews.repository');

/**
 * A buyer reviews a product they received. Only buyers with a COMPLETED
 * sub-order containing the product may review it (checked in Postgres,
 * where orders live), once per product (unique index). The product's rating
 * is then updated in one atomic Mongo update.
 *
 * The review insert and the rating update are two writes; if the process
 * died between them the rating would miss one vote. rating.sum/count make a
 * recompute from the reviews collection exact if that ever needs repairing.
 */
async function create(buyer, productId, { rating, comment = '' }) {
  const product = await productsRepository.findNotDeleted(productId);
  if (!product) throw notFound('Product');

  const subOrderId = await ordersRepository.findCompletedPurchase(db, {
    buyerId: buyer.id,
    productId: String(product._id),
  });
  if (!subOrderId) {
    throw forbidden(
      'You can review a product only after an order for it is completed',
      'REVIEW_NOT_ALLOWED',
    );
  }

  let review;
  try {
    review = await reviewsRepository.create({
      productId: product._id,
      buyerId: buyer.id,
      subOrderId,
      rating,
      comment,
    });
  } catch (err) {
    if (err.code === 11000)
      throw conflict('ALREADY_REVIEWED', 'You have already reviewed this product');
    throw err;
  }

  const updated = await productsRepository.addRating(product._id, rating);
  logger.info({ productId: String(product._id), rating: updated }, 'Review added');
  return { review, productRating: { avg: updated.avg, count: updated.count } };
}

module.exports = { reviewsService: { create } };
