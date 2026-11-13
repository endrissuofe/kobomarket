// LedgerService: the only way money moves. Other modules call post() (inside
// their own transaction when they have one) and never touch ledger tables or
// balance_kobo themselves.

const { AppError, conflict, notFound } = require('../../shared/errors');
const { validatePosting } = require('./ledger.validation');
const { SYSTEM_ACCOUNTS, ACCOUNTS_ALLOWED_NEGATIVE, OWNER_TYPES } = require('./ledger.constants');

/**
 * @param {{ db: import('knex').Knex, repository: ReturnType<typeof import('./ledger.repository').createLedgerRepository> }} deps
 */
function createLedgerService({ db, repository }) {
  /** Run fn in the caller's transaction if given, otherwise in a new one. */
  function inTransaction(trx, fn) {
    return trx ? fn(trx) : db.transaction(fn);
  }

  /**
   * Post one balanced transaction.
   *
   * Order matters: every check that can fail runs before the first write, so
   * a refusal never leaves the caller's transaction aborted or half-written.
   *
   * @param {import('./ledger.validation').Posting} posting
   * @param {import('knex').Knex.Transaction} [trx]
   * @returns {Promise<{ transaction: object, entries: object[], balances: Record<string, number> }>}
   */
  async function post(posting, trx) {
    const valid = validatePosting(posting);
    const accountIds = [...valid.deltas.keys()].sort();

    return inTransaction(trx, async (t) => {
      const accounts = await repository.lockAccounts(t, accountIds);
      if (accounts.length !== accountIds.length) {
        const found = new Set(accounts.map((a) => a.id));
        throw notFound(`Account ${accountIds.find((id) => !found.has(id))}`);
      }

      for (const account of accounts) {
        const delta = valid.deltas.get(account.id);
        if (account.ownerType !== OWNER_TYPES.USER || delta >= 0) continue;

        if (account.status === 'FROZEN') {
          throw new AppError('ACCOUNT_FROZEN', 'This account is frozen', 403, {
            accountId: account.id,
          });
        }
        if (account.balanceKobo + delta < 0) {
          throw new AppError('INSUFFICIENT_FUNDS', 'Insufficient balance', 422, {
            accountId: account.id,
            balanceKobo: account.balanceKobo,
            requiredKobo: -delta,
          });
        }
      }

      const transaction = await repository.insertTransaction(t, valid);
      if (!transaction) {
        const existing = await repository.findTransactionByReferenceOrKey(t, valid);
        throw conflict('DUPLICATE_TRANSACTION', 'This transaction was already posted', {
          transactionId: existing && existing.id,
          reference: valid.reference,
        });
      }

      const entries = await repository.insertEntries(t, transaction.id, valid.entries);

      const balances = {};
      for (const id of accountIds) {
        balances[id] = await repository.applyBalanceDelta(t, id, valid.deltas.get(id));
      }

      return { transaction, entries, balances };
    });
  }

  /** Get (or open) a user's NGN wallet account. */
  function openUserAccount(userId, trx) {
    return repository.findOrCreateAccount(trx || db, {
      ownerType: OWNER_TYPES.USER,
      ownerId: String(userId),
    });
  }

  /** A user's NGN wallet account, or null if it has not been opened. */
  function findUserAccount(userId, trx) {
    return repository.findAccount(trx || db, {
      ownerType: OWNER_TYPES.USER,
      ownerId: String(userId),
    });
  }

  /** Look up a system account by name, e.g. SYSTEM_ACCOUNTS.PLATFORM_ESCROW. */
  async function getSystemAccount(name, trx) {
    const account = await repository.findAccount(trx || db, {
      ownerType: OWNER_TYPES.SYSTEM,
      ownerId: name,
    });
    if (!account) throw notFound(`System account ${name}`);
    return account;
  }

  async function getAccount(id, trx) {
    const account = await repository.findAccountById(trx || db, id);
    if (!account) throw notFound('Account');
    return account;
  }

  /**
   * Check that money is conserved. Returns { ok, checks } where each check
   * lists the rows that break it (empty = pass).
   */
  async function audit(trx) {
    const q = trx || db;
    const net = await repository.ledgerNet(q);
    const checks = {
      ledgerNetsToZero: { ok: net === 0, netKobo: net },
      cachedBalancesMatchLedger: { problems: await repository.balanceMismatches(q) },
      transactionsBalanced: { problems: await repository.malformedTransactions(q) },
      noUnexpectedNegativeBalances: {
        problems: await repository.negativeAccounts(q, ACCOUNTS_ALLOWED_NEGATIVE),
      },
    };
    for (const check of Object.values(checks)) {
      if (check.problems) check.ok = check.problems.length === 0;
    }
    return { ok: Object.values(checks).every((c) => c.ok), checks };
  }

  return {
    post,
    openUserAccount,
    findUserAccount,
    getSystemAccount,
    getAccount,
    audit,
    SYSTEM_ACCOUNTS,
  };
}

module.exports = { createLedgerService };
