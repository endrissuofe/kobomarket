const { Router } = require('express');
const validate = require('../../shared/middleware/validate');
const { requireAuth, requireRole } = require('../../shared/middleware/auth');
const { ordersController } = require('./orders.controller');
const schemas = require('./orders.schemas');
const { disputesController } = require('../disputes/disputes.controller');
const disputeSchemas = require('../disputes/disputes.schemas');

// Mounted at /api/v1/sub-orders.
const router = Router();
router.use(requireAuth);

router.patch(
  '/:id/ship',
  requireRole('vendor'),
  validate({ params: schemas.orderIdParams, body: schemas.shipBody }),
  ordersController.ship,
);
// Any signed-in user may call it; the service checks it is the buyer's own.
router.patch('/:id/confirm', validate({ params: schemas.orderIdParams }), ordersController.confirm);
// The buyer opens a dispute; ownership is checked in the service.
router.post(
  '/:id/disputes',
  validate({ params: schemas.orderIdParams, body: disputeSchemas.openBody }),
  disputesController.open,
);

module.exports = router;
