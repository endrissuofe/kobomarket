const { randomUUID } = require('node:crypto');

const { db } = require('../../db/postgres');
const config = require('../../config');
const { logger } = require('../../shared/logger');
const { conflict } = require('../../shared/errors');
const { paymentProvider } = require('../../integrations/payments');
const { LedgerService } = require('../ledger');
const { WALLET_STATUS } = require('../users/user.model');
const { walletRepository } = require('./wallet.repository');

const walletNotReady = () =>
  conflict('WALLET_NOT_READY', 'Your wallet is still being set up. Try again in a moment.');

/** The user's wallet account, or 409 WALLET_NOT_READY. */
async function walletOf(user) {
  if (user.walletStatus !== WALLET_STATUS.READY) throw walletNotReady();
  const account = await LedgerService.findUserAccount(user.id);
  if (!account) throw walletNotReady();
  return account;
}

/**
 * Start funding: record an INITIATED funding, then ask the provider for a
 * checkout URL. The provider call is an HTTP request, so it runs after the
 * insert has committed, never inside a database transaction. Nothing is
 * credited here; only a verified webhook credits the wallet.
 */
async function fund(user, { amountKobo }) {
  const account = await walletOf(user);
  const funding = await walletRepository.createFunding(db, {
    userId: user.id,
    accountId: account.id,
    provider: paymentProvider.name,
    reference: `KM-FND-${randomUUID()}`,
    amountKobo,
  });

  let checkout;
  try {
    checkout = await paymentProvider.initialize({
      email: user.email,
      amountKobo,
      reference: funding.reference,
      callbackUrl: config.payments.callbackUrl || undefined,
    });
  } catch (err) {
    await walletRepository
      .markFailed(db, funding.id, `initialize failed: ${err.message}`)
      .catch((e) => logger.error({ err: e }, 'Could not mark funding failed'));
    throw err;
  }
  await walletRepository.setAuthorizationUrl(db, funding.id, checkout.authorizationUrl);

  return {
    reference: funding.reference,
    amountKobo,
    status: funding.status,
    authorizationUrl: checkout.authorizationUrl,
  };
}

module.exports = { walletService: { fund }, walletOf };
