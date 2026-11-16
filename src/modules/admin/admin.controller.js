const asyncHandler = require('../../shared/http/asyncHandler');
const { adminService: s } = require('./admin.service');

const ok = (res, data) => res.json({ success: true, data });

const adminController = {
  listUsers: asyncHandler(async (req, res) => ok(res, await s.listUsers(req.query))),
  freeze: asyncHandler(async (req, res) =>
    ok(res, await s.setFrozen(req.user, req.params.id, { frozen: true, reason: req.body.reason })),
  ),
  unfreeze: asyncHandler(async (req, res) =>
    ok(res, await s.setFrozen(req.user, req.params.id, { frozen: false })),
  ),
  walletLedger: asyncHandler(async (req, res) =>
    ok(res, await s.walletLedger(req.params.id, req.query)),
  ),
  listTransactions: asyncHandler(async (req, res) => ok(res, await s.listTransactions(req.query))),
  getSettings: asyncHandler(async (req, res) => ok(res, { settings: await s.getSettings() })),
  setCommission: asyncHandler(async (req, res) =>
    ok(res, { settings: await s.setCommission(req.user, req.body) }),
  ),
  revenue: asyncHandler(async (req, res) => ok(res, await s.revenueReport(req.query))),
  topVendors: asyncHandler(async (req, res) => ok(res, await s.topVendorsReport())),
  escrow: asyncHandler(async (req, res) => ok(res, await s.escrowReport())),
  reconciliation: asyncHandler(async (req, res) => ok(res, await s.reconciliationReport())),
};

module.exports = { adminController };
