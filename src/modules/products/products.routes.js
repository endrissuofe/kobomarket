const { Router } = require('express');
const validate = require('../../shared/middleware/validate');
const { requireAuth, requireRole } = require('../../shared/middleware/auth');
const { productsController } = require('./products.controller');
const schemas = require('./products.schemas');

const router = Router();
const vendorOnly = [requireAuth, requireRole('vendor')];

router.get('/:slug', validate({ params: schemas.slugParams }), productsController.getBySlug);
router.post('/', ...vendorOnly, validate({ body: schemas.createBody }), productsController.create);

module.exports = router;
