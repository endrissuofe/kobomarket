const { Router } = require('express');
const validate = require('../../shared/middleware/validate');
const { requireAuth, requireRole } = require('../../shared/middleware/auth');
const { idParams } = require('../../shared/http/schemas');
const { vendorsController } = require('./vendors.controller');
const schemas = require('./vendors.schemas');
const { productsController } = require('../products/products.controller');
const productSchemas = require('../products/products.schemas');

const router = Router();

router.post('/apply', requireAuth, validate({ body: schemas.applyBody }), vendorsController.apply);
// Before /:id so "me" is not read as an id.
router.get('/me', requireAuth, vendorsController.getMine);
router.get(
  '/me/products',
  requireAuth,
  requireRole('vendor'),
  validate({ query: productSchemas.mineQuery }),
  productsController.listMine,
);
router.get('/:id', validate({ params: idParams }), vendorsController.getPublic);

module.exports = router;
