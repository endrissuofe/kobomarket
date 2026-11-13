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
router.get('/', validate({ query: schemas.listOrdersQuery }), ordersController.list);
router.get('/:id', validate({ params: schemas.orderIdParams }), ordersController.get);
router.post('/:id/cancel', validate({ params: schemas.orderIdParams }), ordersController.cancel);

module.exports = router;
