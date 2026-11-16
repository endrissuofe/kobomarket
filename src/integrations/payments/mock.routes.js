const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../shared/middleware/validate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { paymentProvider } = require('./index');

// The mock provider's "checkout page". Mounted only when PAYMENT_PROVIDER=mock.
//   GET  /mock-paystack/checkout/:reference      what is being paid
//   POST /mock-paystack/checkout/:reference/pay  pay it: the signed
//        charge.success webhook is sent to this API twice, like Paystack may.
const router = Router();
const params = validate({
  params: z.object({ reference: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, 'Invalid reference') }),
});

router.get(
  '/checkout/:reference',
  params,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: paymentProvider.describe(req.params.reference) });
  }),
);

router.post(
  '/checkout/:reference/pay',
  params,
  asyncHandler(async (req, res) => {
    // Deliver to this same server over IPv4, whatever host the caller used.
    const webhookUrl = `http://127.0.0.1:${req.socket.localPort}/api/v1/webhooks/paystack`;
    const deliveries = await paymentProvider.pay(req.params.reference, { webhookUrl });
    res.json({
      success: true,
      data: { reference: req.params.reference, webhookDeliveries: deliveries },
    });
  }),
);

module.exports = router;
