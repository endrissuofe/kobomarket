const { Router } = require('express');
const validate = require('../../shared/middleware/validate');
const { requireAuth, requireRole } = require('../../shared/middleware/auth');
const { idempotent } = require('../../shared/middleware/idempotency');
const { payoutsController } = require('./payouts.controller');
const schemas = require('./payouts.schemas');

// Mounted at /api/v1/payouts. Vendors only.
const router = Router();
router.use(requireAuth, requireRole('vendor'));

router.post(
  '/',
  validate({ body: schemas.requestBody }),
  idempotent('payouts.create'),
  payoutsController.request,
);
router.get('/', validate({ query: schemas.listQuery }), payoutsController.list);

module.exports = router;
