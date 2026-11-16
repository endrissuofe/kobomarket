const { z } = require('zod');
const { verifyWebhookSignature } = require('../../integrations/payments');
const { badRequest, unauthorized, validationError } = require('../../shared/errors');
const { logger } = require('../../shared/logger');
const { walletService } = require('../wallet/wallet.service');
const { webhooksRepository } = require('./webhooks.repository');

// The shape every Paystack event shares. Other fields pass through untouched
// (they are logged as sent); the amount is never read from here anyway: a
// charge is always re-verified with the provider before crediting.
const eventSchema = z.object({
  event: z.string().trim().min(1).max(100),
  data: z
    .object({
      id: z.union([z.number().int(), z.string().min(1).max(100)]).optional(),
      reference: z.string().min(1).max(200).optional(),
    })
    .passthrough()
    .refine((d) => d.id !== undefined || d.reference !== undefined, {
      message: 'data.id or data.reference is required',
    }),
});

/**
 * Handle a Paystack webhook.
 * 1. The HMAC-SHA512 signature of the raw body must match; otherwise 401 and
 *    nothing is stored. Then the JSON must have the event shape (Zod).
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
  const parsed = eventSchema.safeParse(event);
  if (!parsed.success) throw validationError(parsed.error.flatten().fieldErrors);
  const eventType = parsed.data.event;
  const dataId = parsed.data.data.id ?? parsed.data.data.reference;

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
