const { Router } = require('express');
const validate = require('../../shared/middleware/validate');
const { requireAuth, requireRole } = require('../../shared/middleware/auth');
const { pageQuery } = require('../../shared/http/schemas');
const { adminController: c } = require('./admin.controller');
const schemas = require('./admin.schemas');

// Mounted at /api/v1/admin (vendor review lives in vendors.admin.routes.js).
// Every route here is admin-only.
const router = Router();
router.use(requireAuth, requireRole('admin'));

router.get('/users', validate({ query: schemas.usersQuery }), c.listUsers);
router.patch(
  '/users/:id/freeze',
  validate({ params: schemas.idParams, body: schemas.freezeBody }),
  c.freeze,
);
router.patch('/users/:id/unfreeze', validate({ params: schemas.idParams }), c.unfreeze);

router.get(
  '/wallets/:id/ledger',
  validate({ params: schemas.walletParams, query: pageQuery }),
  c.walletLedger,
);
router.get('/transactions', validate({ query: schemas.transactionsQuery }), c.listTransactions);

router.get('/settings', c.getSettings);
router.patch('/settings/commission', validate({ body: schemas.commissionBody }), c.setCommission);

router.get('/reports/revenue', validate({ query: schemas.revenueQuery }), c.revenue);
router.get('/reports/top-vendors', c.topVendors);
router.get('/reports/escrow', c.escrow);
router.get('/reports/reconciliation', c.reconciliation);

module.exports = router;
