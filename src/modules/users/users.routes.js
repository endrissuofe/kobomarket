const { Router } = require('express');
const { requireAuth } = require('../../shared/middleware/auth');
const validate = require('../../shared/middleware/validate');
const { usersController } = require('./users.controller');
const schemas = require('./users.schemas');

const router = Router();

router.get('/me', requireAuth, usersController.getMe);
router.patch(
  '/me',
  requireAuth,
  validate({ body: schemas.updateMeBody }),
  usersController.updateMe,
);

module.exports = router;
