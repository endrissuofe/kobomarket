const { Router } = require('express');
const validate = require('../../shared/middleware/validate');
const { requireAuth } = require('../../shared/middleware/auth');
const { cartController } = require('./cart.controller');
const schemas = require('./cart.schemas');

const router = Router();
router.use(requireAuth);

router.get('/', cartController.get);
router.post('/items', validate({ body: schemas.addItemBody }), cartController.addItem);

module.exports = router;
