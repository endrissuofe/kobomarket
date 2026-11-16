const asyncHandler = require('../../shared/http/asyncHandler');
const { reviewsService } = require('./reviews.service');

const reviewsController = {
  create: asyncHandler(async (req, res) => {
    const result = await reviewsService.create(req.user, req.params.id, req.body);
    res.status(201).json({ success: true, data: result });
  }),
};

module.exports = { reviewsController };
