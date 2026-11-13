const asyncHandler = require('../../shared/http/asyncHandler');
const { ordersService } = require('./orders.service');

const ordersController = {
  checkout: asyncHandler(async (req, res) => {
    const order = await ordersService.checkout(req.user, {
      idempotencyKey: req.get('idempotency-key'),
    });
    res.status(201).json({ success: true, data: { order } });
  }),
};

module.exports = { ordersController };
