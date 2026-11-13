const { Router } = require('express');
const validate = require('../../shared/middleware/validate');
const { authController } = require('./auth.controller');
const schemas = require('./auth.schemas');

const router = Router();

router.post('/register', validate({ body: schemas.registerBody }), authController.register);
router.post(
  '/verify-email',
  validate({ body: schemas.verifyEmailBody }),
  authController.verifyEmail,
);

module.exports = router;
