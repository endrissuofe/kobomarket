const { Review } = require('./review.model');

// The only code that queries the reviews collection.
const reviewsRepository = {
  create({ productId, buyerId, subOrderId, rating, comment }) {
    return Review.create({ productId, buyerId, subOrderId, rating, comment });
  },
};

module.exports = { reviewsRepository };
