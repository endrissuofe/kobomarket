const { verifyWebhookSignature } = require('../../integrations/payments');
const { badRequest, unauthorized } = require('../../shared/errors');
const { logger } = require('../../shared/logger');
const { walletService } = require('../wallet/wallet.service');
const { webhooksRepository } = require('./webhooks.repository');

/**
 * Handle a Paystack webhook.
 * 1. The HMAC-SHA512 signature of the raw body must match; otherwise 401 and
 *    nothing is stored.
 * 2. The event is logged in webhook_events (UNIQUE provider + event id). An
 *    event already processed is acknowledged and ignored. One that was logged
 *    but not processed (the first attempt failed) is processed again.
 * 3. charge.success credits the funding (see walletService.creditFunding).
 * If processing throws, the error reaches the client as a 5xx so Paystack
 * retries later; the event stays unprocessed.
 */
async function handlePaystack(rawBody, signature) {
  if (!Buffer.isBuffer(rawBody) || !verifyWebhookSignature(rawBody, signature)) {
    throw unauthorized('Invalid webhook signature', 'INVALID_SIGNATURE');
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw badRequest('Webhook body is not valid JSON');
  }
  const eventType = String(event?.event || 'unknown');
  const dataId = event?.data?.id ?? event?.data?.reference;
  if (dataId === undefined) throw badRequest('Webhook event has no data id');

  const logged = await webhooksRepository.record({
    provider: 'paystack',
    eventId: `${eventType}:${dataId}`,
    eventType,
    payload: event,
  });
  if (logged.processed_at) return { outcome: 'duplicate' };

  const outcome =
    eventType === 'charge.success'
      ? await walletService.creditFunding(String(event.data.reference))
      : 'ignored';

  await webhooksRepository.markProcessed(logged.id, outcome);
  logger.info({ eventType, reference: event.data?.reference, outcome }, 'Paystack webhook handled');
  return { outcome };
}

module.exports = { webhooksService: { handlePaystack } };
