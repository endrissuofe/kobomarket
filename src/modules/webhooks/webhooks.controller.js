const asyncHandler = require('../../shared/http/asyncHandler');
const { webhooksService } = require('./webhooks.service');

const webhooksController = {
  paystack: asyncHandler(async (req, res) => {
    const { outcome } = await webhooksService.handlePaystack(
      req.body,
      req.get('x-paystack-signature'),
    );
    res.json({ success: true, data: { received: true, outcome } });
  }),
};

module.exports = { webhooksController };
