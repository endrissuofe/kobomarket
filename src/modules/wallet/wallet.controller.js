const asyncHandler = require('../../shared/http/asyncHandler');
const { walletService } = require('./wallet.service');

const walletController = {
  fund: asyncHandler(async (req, res) => {
    const funding = await walletService.fund(req.user, req.body);
    res.status(201).json({ success: true, data: { funding } });
  }),

  getWallet: asyncHandler(async (req, res) => {
    const wallet = await walletService.getWallet(req.user);
    res.json({ success: true, data: { wallet } });
  }),

  listTransactions: asyncHandler(async (req, res) => {
    const page = await walletService.listTransactions(req.user, req.query);
    res.json({ success: true, data: page });
  }),
};

module.exports = { walletController };
