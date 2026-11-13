const { Router } = require('express');
const validate = require('../../shared/middleware/validate');
const { requireAuth } = require('../../shared/middleware/auth');
const { idempotent } = require('../../shared/middleware/idempotency');
const { walletController } = require('./wallet.controller');
const schemas = require('./wallet.schemas');

const router = Router();
router.use(requireAuth);

router.post(
  '/fund',
  validate({ body: schemas.fundBody }),
  idempotent('wallet.fund'),
  walletController.fund,
);

module.exports = router;
