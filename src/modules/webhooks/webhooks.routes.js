const express = require('express');
const { webhooksController } = require('./webhooks.controller');

// Mounted BEFORE express.json(): the signature is computed over the exact
// bytes the provider sent, so the body must stay a raw Buffer here.
const router = express.Router();

router.post(
  '/paystack',
  express.raw({ type: () => true, limit: '100kb' }),
  webhooksController.paystack,
);

module.exports = router;
