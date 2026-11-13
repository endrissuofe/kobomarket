const { db, withTransaction } = require('../db/postgres');
const { logger } = require('../shared/logger');
const { paymentProvider } = require('../integrations/payments');
const { LedgerService, SYSTEM_ACCOUNTS, TRANSACTION_TYPES } = require('../modules/ledger');
const { payoutsRepository } = require('../modules/payouts/payouts.repository');
const { outboxRepository, OUTBOX_EVENTS } = require('../modules/outbox/outbox.repository');

const LEASE_SECONDS = 120;
const PENDING_RECHECK_SECONDS = 60;
const ALERT_AFTER_ATTEMPTS = 10;

/** Record the provider's final answer: settle or return the money, once. */
async function finish(payout, outcome) {
  return withTransaction(async (trx) => {
    const locked = await payoutsRepository.lock(trx, payout.id);
    if (locked.status !== 'PENDING') return 'already_finished';

    const clearing = await LedgerService.getSystemAccount(
      SYSTEM_ACCOUNTS.PLATFORM_PAYOUT_CLEARING,
      trx,
    );
    const succeeded = outcome.status === 'success';
    const counterparty = succeeded
      ? (await LedgerService.getSystemAccount(SYSTEM_ACCOUNTS.EXTERNAL_PAYSTACK, trx)).id
      : locked.accountId;

    const { transaction } = await LedgerService.post(
      {
        reference: `PAY-${locked.id}-${succeeded ? 'SETTLE' : 'REV'}`,
        type: succeeded ? TRANSACTION_TYPES.PAYOUT_SETTLE : TRANSACTION_TYPES.PAYOUT_REVERSAL,
        entries: [
          { accountId: clearing.id, direction: 'debit', amountKobo: locked.amountKobo },
          { accountId: counterparty, direction: 'credit', amountKobo: locked.amountKobo },
        ],
        metadata: { payoutId: locked.id, providerRef: outcome.providerRef, reason: outcome.reason },
      },
      trx,
    );

    await payoutsRepository.finish(trx, locked.id, {
      status: succeeded ? 'SUCCESS' : 'FAILED',
      provider_ref: outcome.providerRef,
      ...(succeeded
        ? { settle_txn_id: transaction.id }
        : { reversal_txn_id: transaction.id, failure_reason: outcome.reason || 'Transfer failed' }),
    });
    await outboxRepository.add(trx, {
      aggregate: 'payout',
      aggregateId: locked.id,
      eventType: succeeded ? OUTBOX_EVENTS.PAYOUT_SUCCEEDED : OUTBOX_EVENTS.PAYOUT_FAILED,
      payload: {
        payoutId: locked.id,
        vendorUserId: locked.vendorUserId,
        amountKobo: locked.amountKobo,
        reason: succeeded ? null : outcome.reason,
      },
    });
    return succeeded ? 'settled' : 'reversed';
  });
}

/**
 * Process PENDING payouts. Each is claimed with a lease (SKIP LOCKED), the
 * transfer is sent outside any database transaction, then the result is
 * recorded in one transaction that re-locks the payout:
 *   success -> PAYOUT_SETTLE (clearing -> EXTERNAL_PAYSTACK), SUCCESS
 *   failure -> PAYOUT_REVERSAL (clearing -> vendor wallet), FAILED
 *   pending -> left PENDING and checked again in a minute
 * The payout id is the transfer reference, so retrying never pays twice.
 * If the provider cannot be reached the payout stays PENDING (we cannot know
 * whether money left, so we never reverse on an error); it is retried and an
 * error is logged after 10 attempts for an admin to check.
 */
async function runPayoutProcessor({ batchSize = 20 } = {}) {
  const claimed = await payoutsRepository.claimPending(db, {
    limit: batchSize,
    leaseSeconds: LEASE_SECONDS,
  });
  const result = { settled: 0, reversed: 0, pending: 0, errors: 0 };

  for (const payout of claimed) {
    let outcome;
    try {
      outcome = await paymentProvider.transfer({
        reference: payout.id,
        amountKobo: payout.amountKobo,
        bank: payout.bank,
        reason: 'KoboMarket vendor payout',
      });
    } catch (err) {
      result.errors += 1;
      const log = payout.attempts >= ALERT_AFTER_ATTEMPTS ? 'error' : 'warn';
      logger[log](
        { err, payoutId: payout.id, attempts: payout.attempts },
        'Payout transfer error; will retry',
      );
      continue;
    }

    if (outcome.status === 'pending') {
      await payoutsRepository.postpone(db, payout.id, {
        providerRef: outcome.providerRef,
        seconds: PENDING_RECHECK_SECONDS,
      });
      result.pending += 1;
      continue;
    }

    try {
      const done = await finish(payout, outcome);
      if (done === 'settled') result.settled += 1;
      if (done === 'reversed') result.reversed += 1;
    } catch (err) {
      result.errors += 1;
      logger.error({ err, payoutId: payout.id }, 'Could not record payout result; will retry');
    }
  }
  if (claimed.length) logger.info(result, 'Payout processor run');
  return result;
}

module.exports = { runPayoutProcessor };
