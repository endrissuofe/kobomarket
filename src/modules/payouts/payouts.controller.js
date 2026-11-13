const asyncHandler = require('../../shared/http/asyncHandler');
const { payoutsService } = require('./payouts.service');

const payoutsController = {
  request: asyncHandler(async (req, res) => {
    const payout = await payoutsService.requestPayout(req.user, req.body, {
      idempotencyKey: req.get('idempotency-key'),
    });
    res.status(201).json({ success: true, data: { payout } });
  }),

  list: asyncHandler(async (req, res) => {
    res.json({ success: true, data: await payoutsService.listPayouts(req.user, req.query) });
  }),
};

module.exports = { payoutsController };
