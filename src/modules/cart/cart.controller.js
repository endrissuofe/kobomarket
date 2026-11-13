const asyncHandler = require('../../shared/http/asyncHandler');
const { cartService } = require('./cart.service');

const cartController = {
  get: asyncHandler(async (req, res) => {
    res.json({ success: true, data: { cart: await cartService.review(req.user.id) } });
  }),

  addItem: asyncHandler(async (req, res) => {
    const cart = await cartService.addItem(req.user, req.body);
    res.status(201).json({ success: true, data: { cart } });
  }),

  updateItem: asyncHandler(async (req, res) => {
    const cart = await cartService.updateItem(req.user, req.params.itemId, req.body);
    res.json({ success: true, data: { cart } });
  }),

  removeItem: asyncHandler(async (req, res) => {
    const cart = await cartService.removeItem(req.user, req.params.itemId);
    res.json({ success: true, data: { cart } });
  }),
};

module.exports = { cartController };
