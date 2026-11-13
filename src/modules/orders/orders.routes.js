const { Router } = require('express');
const validate = require('../../shared/middleware/validate');
const { requireAuth } = require('../../shared/middleware/auth');
const { idempotent } = require('../../shared/middleware/idempotency');
const { ordersController } = require('./orders.controller');
const schemas = require('./orders.schemas');

const router = Router();
router.use(requireAuth);

router.post(
  '/checkout',
  validate({ body: schemas.checkoutBody }),
  idempotent('orders.checkout'),
  ordersController.checkout,
);

module.exports = router;
