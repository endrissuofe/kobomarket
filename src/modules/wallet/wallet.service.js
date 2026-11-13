const { randomUUID } = require('node:crypto');

const { db, withTransaction } = require('../../db/postgres');
const config = require('../../config');
const { logger } = require('../../shared/logger');
const { conflict } = require('../../shared/errors');
const { paymentProvider } = require('../../integrations/payments');
const { LedgerService, SYSTEM_ACCOUNTS, TRANSACTION_TYPES } = require('../ledger');
const { WALLET_STATUS } = require('../users/user.model');
const { walletRepository } = require('./wallet.repository');
const { FUNDING_STATUS } = require('./wallet.constants');

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

/**
 * Credit a funding after the provider says it was paid. Called by the webhook.
 * Returns an outcome string for the webhook log. Safe to call any number of
 * times, in parallel: three guards make the credit happen at most once.
 *   1. The funding row is locked (FOR UPDATE) and re-checked inside the transaction.
 *   2. The ledger transaction reference is the provider reference (UNIQUE).
 *   3. The webhook event id is UNIQUE (checked by the webhook before calling this).
 *
 * The webhook body is never trusted for the amount: the provider's verify
 * endpoint is asked (outside the transaction), and its amount and currency
 * must match what this funding asked for.
 */
async function creditFunding(reference) {
  const funding = await walletRepository.findByReference(db, reference);
  if (!funding) return 'unknown_reference';
  if (funding.status === FUNDING_STATUS.SUCCESS) return 'already_credited';
  if (funding.status === FUNDING_STATUS.FAILED) return 'funding_failed';

  const verified = await paymentProvider.verify(reference);
  if (verified.status !== 'success') return `not_paid:${verified.status}`;
  if (verified.amountKobo !== funding.amountKobo || verified.currency !== funding.currency) {
    const reason = `verify mismatch: paid ${verified.amountKobo} ${verified.currency}, expected ${funding.amountKobo} ${funding.currency}`;
    logger.error({ reference, verified, expected: funding.amountKobo }, 'Funding amount mismatch');
    await walletRepository.markFailed(db, funding.id, reason);
    return 'amount_mismatch';
  }

  return withTransaction(async (trx) => {
    const locked = await walletRepository.lockById(trx, funding.id);
    if (locked.status !== FUNDING_STATUS.INITIATED) {
      return locked.status === FUNDING_STATUS.SUCCESS ? 'already_credited' : 'funding_failed';
    }
    const external = await LedgerService.getSystemAccount(SYSTEM_ACCOUNTS.EXTERNAL_PAYSTACK, trx);
    const { transaction } = await LedgerService.post(
      {
        reference,
        type: TRANSACTION_TYPES.FUNDING,
        entries: [
          { accountId: external.id, direction: 'debit', amountKobo: funding.amountKobo },
          { accountId: funding.accountId, direction: 'credit', amountKobo: funding.amountKobo },
        ],
        metadata: { fundingId: funding.id, provider: funding.provider, userId: funding.userId },
      },
      trx,
    );
    await walletRepository.markSuccess(trx, funding.id, transaction.id);
    return 'credited';
  });
}

module.exports = { walletService: { fund, creditFunding }, walletOf };
