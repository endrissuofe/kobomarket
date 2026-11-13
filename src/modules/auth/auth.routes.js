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
router.post('/login', validate({ body: schemas.loginBody }), authController.login);
router.post('/refresh', validate({ body: schemas.refreshBody }), authController.refresh);
router.post('/logout', validate({ body: schemas.refreshBody }), authController.logout);
router.post(
  '/forgot-password',
  validate({ body: schemas.forgotPasswordBody }),
  authController.forgotPassword,
);
router.post(
  '/reset-password',
  validate({ body: schemas.resetPasswordBody }),
  authController.resetPassword,
);

module.exports = router;
