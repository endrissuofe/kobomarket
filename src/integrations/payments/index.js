const config = require('../../config');
const { createPaystackProvider } = require('./paystack');
const { createMockProvider } = require('./mock');
const { sign, isValidSignature } = require('./signature');

// One provider per process, chosen by PAYMENT_PROVIDER.
const paymentProvider =
  config.payments.provider === 'paystack'
    ? createPaystackProvider({
        secretKey: config.payments.paystackSecret,
        baseUrl: config.payments.paystackBaseUrl,
      })
    : createMockProvider({ secretKey: config.payments.paystackSecret });

/** Check x-paystack-signature against the raw body with the configured secret. */
const verifyWebhookSignature = (rawBody, signature) =>
  isValidSignature(rawBody, signature, config.payments.paystackSecret);

module.exports = { paymentProvider, verifyWebhookSignature, sign };
