const { Router } = require('express');
const validate = require('../../shared/middleware/validate');
const { requireAuth, requireRole } = require('../../shared/middleware/auth');
const { idParams } = require('../../shared/http/schemas');
const { productsController } = require('./products.controller');
const schemas = require('./products.schemas');

const router = Router();
const vendorOnly = [requireAuth, requireRole('vendor')];

router.get('/', validate({ query: schemas.listQuery }), productsController.list);
router.get('/:slug', validate({ params: schemas.slugParams }), productsController.getBySlug);
router.post('/', ...vendorOnly, validate({ body: schemas.createBody }), productsController.create);
router.patch(
  '/:id',
  ...vendorOnly,
  validate({ params: idParams, body: schemas.updateBody }),
  productsController.update,
);
router.delete('/:id', ...vendorOnly, validate({ params: idParams }), productsController.remove);

module.exports = router;
