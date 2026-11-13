const { db } = require('../db/postgres');
const { logger } = require('../shared/logger');
const { outboxRepository } = require('../modules/outbox/outbox.repository');

const MAX_ATTEMPTS = 10;
const LEASE_SECONDS = 60;

/**
 * Relay due outbox rows to the event queue.
 *
 * Rows are claimed in a short transaction (SKIP LOCKED + a lease), published
 * after it commits (no network call while holding row locks), then marked
 * SENT, or backed off exponentially and marked DEAD after 10 attempts. A
 * worker crash between publish and mark means the row is published again
 * after the lease: delivery is at least once, so event handlers must be
 * idempotent (the queue also de-duplicates by outbox id).
 *
 * @param {{ publish: (event: object) => Promise<void>, batchSize?: number }} opts
 * @returns {Promise<{ sent: number, failed: number }>}
 */
async function relayOutbox({ publish, batchSize = 100 }) {
  const rows = await outboxRepository.claimDue(db, {
    limit: batchSize,
    leaseSeconds: LEASE_SECONDS,
  });
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await publish({
        outboxId: row.id,
        eventType: row.event_type,
        aggregate: row.aggregate,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        createdAt: row.created_at,
      });
      await outboxRepository.markSent(db, row.id);
      sent += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ err, outboxId: row.id, attempts: row.attempts + 1 }, 'Outbox publish failed');
      await outboxRepository.markFailed(db, row.id, err.message, MAX_ATTEMPTS);
    }
  }
  if (rows.length) logger.info({ sent, failed }, 'Outbox relay batch');
  return { sent, failed };
}

module.exports = { relayOutbox, MAX_ATTEMPTS };
