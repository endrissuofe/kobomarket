const { db, withTransaction } = require('../db/postgres');
const { logger } = require('../shared/logger');
const { ordersRepository } = require('../modules/orders/orders.repository');
const { releaseEscrow } = require('../modules/orders/orders.service');

/**
 * Auto-complete: a SHIPPED sub-order whose escrow timeout has passed (72 h by
 * default, set when it shipped) is completed and its escrow released, as if
 * the buyer had confirmed.
 *
 * DISPUTED sub-orders are never touched: each sub-order is re-locked in its
 * own transaction with a condition of status = SHIPPED, so one disputed (or
 * confirmed) since the scan simply does not match. SKIP LOCKED means a
 * sub-order held by a buyer's confirm, or by another worker running this
 * job, is skipped rather than waited on; the release can only happen once.
 *
 * @returns {Promise<{ completed: string[], skipped: string[], failed: string[] }>}
 */
async function runAutoComplete({ batchSize = 50 } = {}) {
  const ids = await ordersRepository.findDueForAutoComplete(db, batchSize);
  const result = { completed: [], skipped: [], failed: [] };

  for (const id of ids) {
    try {
      const done = await withTransaction(async (trx) => {
        const sub = await ordersRepository.lockDueSubOrder(trx, id);
        if (!sub) return false;
        await releaseEscrow(trx, sub, {
          actorId: 'system',
          reason: 'auto-completed: escrow timeout passed without buyer action',
        });
        return true;
      });
      result[done ? 'completed' : 'skipped'].push(id);
    } catch (err) {
      // One bad sub-order must not stop the rest; it is retried next run.
      logger.error({ err, subOrderId: id }, 'Auto-complete failed for sub-order');
      result.failed.push(id);
    }
  }

  if (ids.length) logger.info({ ...countOf(result) }, 'Auto-complete run finished');
  return result;
}

const countOf = (r) => ({
  completed: r.completed.length,
  skipped: r.skipped.length,
  failed: r.failed.length,
});

module.exports = { runAutoComplete };
