const { randomUUID } = require('node:crypto');

const { db, withTransaction } = require('../../db/postgres');
const { AppError, badRequest, conflict, forbidden } = require('../../shared/errors');
const { decodeCursor, paginate } = require('../../shared/http/cursor');
const { paymentProvider } = require('../../integrations/payments');
const { LedgerService, SYSTEM_ACCOUNTS, TRANSACTION_TYPES } = require('../ledger');
const { USER_STATUS } = require('../users/user.model');
const { approvedStoreOf } = require('../products/products.service');
const { walletOf } = require('../wallet/wallet.service');
const { settingsService } = require('../settings/settings.service');
const { payoutsRepository, toView } = require('./payouts.repository');

const payoutPending = () =>
  conflict('PAYOUT_PENDING', 'You already have a payout in progress; wait for it to finish');

/**
 * A vendor asks to withdraw. The money leaves the wallet at once
 * (PAYOUT_HOLD: wallet -> PLATFORM_PAYOUT_CLEARING) and the payout is PENDING
 * until the processor job sends the transfer.
 *
 * Same-millisecond requests: the hold is posted first, which locks the wallet
 * row, so requests queue. The second then fails either INSUFFICIENT_FUNDS or
 * on the one-PENDING-per-vendor unique index (409); either way its whole
 * transaction rolls back. The balance can never be overdrawn.
 */
async function requestPayout(user, { amountKobo }, { idempotencyKey } = {}) {
  if (user.status === USER_STATUS.FROZEN)
    throw forbidden('Your account is frozen', 'ACCOUNT_FROZEN');
  const store = await approvedStoreOf(user);
  const { payoutMinKobo } = await settingsService.getBusinessSettings();
  if (amountKobo < payoutMinKobo) {
    throw new AppError('BELOW_PAYOUT_MINIMUM', `The minimum payout is ${payoutMinKobo} kobo`, 422, {
      minimumKobo: payoutMinKobo,
    });
  }
  const account = await walletOf(user);
  const vendorId = String(store._id);
  if (await payoutsRepository.hasPending(db, vendorId)) throw payoutPending();

  const id = randomUUID();
  try {
    await withTransaction(async (trx) => {
      const clearing = await LedgerService.getSystemAccount(
        SYSTEM_ACCOUNTS.PLATFORM_PAYOUT_CLEARING,
        trx,
      );
      const { transaction } = await LedgerService.post(
        {
          reference: `PAY-${id}-HOLD`,
          type: TRANSACTION_TYPES.PAYOUT_HOLD,
          entries: [
            { accountId: account.id, direction: 'debit', amountKobo },
            { accountId: clearing.id, direction: 'credit', amountKobo },
          ],
          metadata: { payoutId: id, vendorId },
        },
        trx,
      );
      await payoutsRepository.insert(trx, {
        id,
        vendorId,
        vendorUserId: user.id,
        accountId: account.id,
        amountKobo,
        bank: store.bank,
        provider: paymentProvider.name,
        idempotencyKey,
        holdTxnId: transaction.id,
      });
    });
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'payouts_one_pending_per_vendor') {
      throw payoutPending();
    }
    throw err;
  }
  return toView(await payoutsRepository.find(db, id));
}

const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listPayouts(user, { limit, cursor }) {
  const store = await approvedStoreOf(user);
  const after = decodeCursor(cursor);
  if (after && (!PG_TIMESTAMP.test(String(after.t)) || !UUID.test(String(after.id)))) {
    throw badRequest('Invalid cursor');
  }
  const rows = await payoutsRepository.listForVendor(db, String(store._id), {
    after,
    limit: limit + 1,
  });
  const page = paginate(rows, limit, (p) => ({ t: p.cursorTime, id: p.id }));
  return { items: page.items.map(toView), nextCursor: page.nextCursor };
}

module.exports = { payoutsService: { requestPayout, listPayouts } };
