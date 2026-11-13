const { idempotencyRepository } = require('../modules/idempotency/idempotency.repository');
const { logger } = require('../shared/logger');

/** Delete Idempotency-Key records past their 24-hour expiry. */
async function runIdempotencyCleanup() {
  const deleted = await idempotencyRepository.deleteExpired();
  if (deleted) logger.info({ deleted }, 'Expired idempotency keys deleted');
  return { deleted };
}

module.exports = { runIdempotencyCleanup };
