const { Router } = require('express');
const validate = require('../../shared/middleware/validate');
const { requireAuth, requireRole } = require('../../shared/middleware/auth');
const { disputesController } = require('./disputes.controller');
const schemas = require('./disputes.schemas');

// Mounted at /api/v1/disputes. Opening a dispute lives on the sub-orders
// router: POST /api/v1/sub-orders/:id/disputes.
const router = Router();
router.use(requireAuth);
const adminOnly = requireRole('admin');

// Before /:id so "mine" is not read as an id.
router.get('/mine', validate({ query: schemas.listQuery }), disputesController.listMine);
router.get('/', adminOnly, validate({ query: schemas.listQuery }), disputesController.listAll);
router.get(
  '/:id',
  adminOnly,
  validate({ params: schemas.disputeIdParams }),
  disputesController.get,
);
router.patch(
  '/:id/respond',
  requireRole('vendor'),
  validate({ params: schemas.disputeIdParams, body: schemas.respondBody }),
  disputesController.respond,
);
router.patch(
  '/:id/resolve',
  adminOnly,
  validate({ params: schemas.disputeIdParams, body: schemas.resolveBody }),
  disputesController.resolve,
);

module.exports = router;
