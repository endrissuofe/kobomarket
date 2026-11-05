// Test factories for the ledger. The ledger is append-only (TRUNCATE is
// blocked too), so tests never wipe tables: each test opens its own accounts
// under a unique owner id and only asserts on those. Wallets are funded
// through LedgerService.post(), never by writing balance_kobo, so
// audit:ledger stays green after a test run.

const { randomUUID } = require('node:crypto');
const { LedgerService, SYSTEM_ACCOUNTS, TRANSACTION_TYPES } = require('../../src/modules/ledger');

const uniqueRef = (prefix = 'TEST') => `${prefix}-${randomUUID()}`;

/** Open a fresh user wallet, optionally funded from EXTERNAL_PAYSTACK. */
async function makeWallet({ balance = 0 } = {}) {
  const account = await LedgerService.openUserAccount(`test-user-${randomUUID()}`);
  if (balance > 0) await fund(account.id, balance);
  return LedgerService.getAccount(account.id);
}

async function fund(accountId, amountKobo) {
  const paystack = await LedgerService.getSystemAccount(SYSTEM_ACCOUNTS.EXTERNAL_PAYSTACK);
  return LedgerService.post({
    reference: uniqueRef('FUND'),
    type: TRANSACTION_TYPES.FUNDING,
    entries: [
      { accountId: paystack.id, direction: 'debit', amountKobo },
      { accountId, direction: 'credit', amountKobo },
    ],
  });
}

/** Resolve to the AppError code a promise rejects with, or 'NO_ERROR'. */
async function errorCode(promise) {
  try {
    await promise;
    return 'NO_ERROR';
  } catch (err) {
    return err.code;
  }
}

module.exports = { uniqueRef, makeWallet, fund, errorCode };
