const { Router } = require('express');
const validate = require('../../shared/middleware/validate');
const { requireAuth, requireRole } = require('../../shared/middleware/auth');
const { idParams } = require('../../shared/http/schemas');
const { vendorsController } = require('./vendors.controller');
const schemas = require('./vendors.schemas');

// Mounted at /api/v1/admin/vendors. Every route here is admin-only.
const router = Router();
router.use(requireAuth, requireRole('admin'));

router.get('/', validate({ query: schemas.listQuery }), vendorsController.list);
router.patch('/:id/approve', validate({ params: idParams }), vendorsController.approve);
router.patch(
  '/:id/reject',
  validate({ params: idParams, body: schemas.rejectBody }),
  vendorsController.reject,
);

module.exports = router;
