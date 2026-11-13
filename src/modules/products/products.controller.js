const asyncHandler = require('../../shared/http/asyncHandler');
const { productsService } = require('./products.service');

const productsController = {
  create: asyncHandler(async (req, res) => {
    const product = await productsService.create(req.user, req.body);
    res.status(201).json({ success: true, data: { product } });
  }),

  getBySlug: asyncHandler(async (req, res) => {
    const product = await productsService.getBySlug(req.params.slug);
    res.json({ success: true, data: { product } });
  }),
};

module.exports = { productsController };
