const { usersRepository } = require('./users.repository');
const { WALLET_STATUS } = require('./user.model');
const { LedgerService } = require('../ledger');
const { logger } = require('../../shared/logger');
const { notFound } = require('../../shared/errors');

/**
 * Open the user's wallet in Postgres, then mark the Mongo user READY.
 * openUserAccount is idempotent (unique owner key), so this is safe to retry:
 * registration calls it once, and the wallet reconciler job retries users left
 * PENDING. Returns true when the wallet is ready.
 */
async function provisionWallet(userId) {
  try {
    await LedgerService.openUserAccount(String(userId));
    await usersRepository.setWalletStatus(userId, WALLET_STATUS.READY);
    return true;
  } catch (err) {
    logger.warn(
      { err, userId: String(userId) },
      'Wallet provisioning failed; left PENDING for retry',
    );
    return false;
  }
}

async function getById(userId) {
  const user = await usersRepository.findById(userId);
  if (!user) throw notFound('User');
  return user;
}

module.exports = { usersService: { provisionWallet, getById } };
