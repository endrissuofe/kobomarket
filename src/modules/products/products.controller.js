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

  update: asyncHandler(async (req, res) => {
    const product = await productsService.update(req.user, req.params.id, req.body);
    res.json({ success: true, data: { product } });
  }),

  remove: asyncHandler(async (req, res) => {
    await productsService.remove(req.user, req.params.id);
    res.status(204).end();
  }),

  list: asyncHandler(async (req, res) => {
    const page = await productsService.list(req.query);
    res.json({ success: true, data: page });
  }),

  listMine: asyncHandler(async (req, res) => {
    const page = await productsService.listMine(req.user, req.query);
    res.json({ success: true, data: page });
  }),
};

module.exports = { productsController };
