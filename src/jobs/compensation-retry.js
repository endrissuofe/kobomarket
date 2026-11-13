const { compensationsRepository } = require('../modules/compensations/compensations.repository');
const { COMPENSATION_TYPES } = require('../modules/compensations/compensation.model');
const { productsRepository } = require('../modules/products/products.repository');
const { logger } = require('../shared/logger');

const MAX_ATTEMPTS = 10;
const LEASE_SECONDS = 60;

const HANDLERS = {
  async [COMPENSATION_TYPES.STOCK_RELEASE](payload) {
    if (!(await productsRepository.releaseStock(payload))) throw new Error('product not found');
  },
};

/**
 * Retry clean-up steps that failed at the time (e.g. putting stock back after
 * a failed checkout). Each is claimed with a lease, so two workers never run
 * the same one. After 10 failures it is DEAD and left for an admin.
 * If a worker dies after the step but before marking it done, the step runs
 * again after the lease: rare, and logged.
 */
async function runCompensationRetry({ max = 50 } = {}) {
  let done = 0;
  let failed = 0;
  for (let i = 0; i < max; i += 1) {
    const job = await compensationsRepository.claimNext({ leaseSeconds: LEASE_SECONDS });
    if (!job) break;
    try {
      await HANDLERS[job.type](job.payload);
      await compensationsRepository.markDone(job._id);
      done += 1;
    } catch (err) {
      failed += 1;
      logger.warn(
        { err, compensationId: String(job._id), type: job.type },
        'Compensation retry failed',
      );
      await compensationsRepository.markFailed(job._id, err.message, MAX_ATTEMPTS);
    }
  }
  if (done || failed) logger.info({ done, failed }, 'Compensation retry run');
  return { done, failed };
}

module.exports = { runCompensationRetry, MAX_ATTEMPTS };
