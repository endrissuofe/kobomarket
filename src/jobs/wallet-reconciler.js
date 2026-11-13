const { usersRepository } = require('../modules/users/users.repository');
const { usersService } = require('../modules/users/users.service');
const { logger } = require('../shared/logger');

const GRACE_SECONDS = 30;

/**
 * Cross-database consistency for registration: a user created in MongoDB
 * whose Postgres wallet could not be opened stays walletStatus PENDING.
 * This retries them (after a short grace period, so it does not race the
 * registration request itself). provisionWallet is idempotent.
 */
async function runWalletReconciler({ batchSize = 100, graceSeconds = GRACE_SECONDS } = {}) {
  const olderThan = new Date(Date.now() - graceSeconds * 1000);
  const users = await usersRepository.findPendingWallets({ olderThan, limit: batchSize });
  let fixed = 0;
  for (const { _id } of users) {
    if (await usersService.provisionWallet(_id)) fixed += 1;
  }
  if (users.length) logger.info({ pending: users.length, fixed }, 'Wallet reconciler run');
  return { pending: users.length, fixed };
}

module.exports = { runWalletReconciler };
