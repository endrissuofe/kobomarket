const asyncHandler = require('../../shared/http/asyncHandler');
const { walletService } = require('./wallet.service');

const walletController = {
  fund: asyncHandler(async (req, res) => {
    const funding = await walletService.fund(req.user, req.body);
    res.status(201).json({ success: true, data: { funding } });
  }),
};

module.exports = { walletController };
