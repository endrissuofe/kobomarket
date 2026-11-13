// Wallet test helpers: start a funding and build signed webhooks for it.
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const config = require('../../src/config');
const { paymentProvider, sign } = require('../../src/integrations/payments');

async function startFunding(app, user, amountKobo) {
  const res = await request(app)
    .post('/api/v1/wallet/fund')
    .set(user.auth)
    .set('Idempotency-Key', randomUUID())
    .send({ amountKobo });
  if (res.status !== 201) throw new Error(`fund failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.funding;
}

/** Mark the mock payment paid without delivering, and return the signed webhook. */
async function paidWebhook(reference) {
  const payment = paymentProvider.describe(reference);
  if (payment.status === 'pending') paymentProvider.tamper(reference, { status: 'success' });
  const body = paymentProvider.chargeSuccessEvent(reference);
  return { body, signature: sign(body, config.payments.paystackSecret) };
}

const sendWebhook = (app, { body, signature }) => {
  const req = request(app)
    .post('/api/v1/webhooks/paystack')
    .set('Content-Type', 'application/json');
  if (signature !== undefined) req.set('x-paystack-signature', signature);
  return req.send(body);
};

module.exports = { startFunding, paidWebhook, sendWebhook };
