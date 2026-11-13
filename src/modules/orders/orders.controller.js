const asyncHandler = require('../../shared/http/asyncHandler');
const { ordersService } = require('./orders.service');

const ordersController = {
  checkout: asyncHandler(async (req, res) => {
    const order = await ordersService.checkout(req.user, {
      idempotencyKey: req.get('idempotency-key'),
    });
    res.status(201).json({ success: true, data: { order } });
  }),

  ship: asyncHandler(async (req, res) => {
    const subOrder = await ordersService.ship(req.user, req.params.id, req.body);
    res.json({ success: true, data: { subOrder } });
  }),

  confirm: asyncHandler(async (req, res) => {
    const subOrder = await ordersService.confirmDelivery(req.user, req.params.id);
    res.json({ success: true, data: { subOrder } });
  }),

  cancel: asyncHandler(async (req, res) => {
    const order = await ordersService.cancelOrder(req.user, req.params.id);
    res.json({ success: true, data: { order } });
  }),

  list: asyncHandler(async (req, res) => {
    res.json({ success: true, data: await ordersService.listOrdersForBuyer(req.user, req.query) });
  }),

  get: asyncHandler(async (req, res) => {
    const order = await ordersService.getOrderForBuyer(req.user, req.params.id);
    res.json({ success: true, data: { order } });
  }),

  listVendorSubOrders: asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: await ordersService.listSubOrdersForVendor(req.user, req.query),
    });
  }),
};

module.exports = { ordersController };
