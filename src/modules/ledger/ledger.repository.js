// The only code that reads or writes accounts, transactions and
// ledger_entries. Every function takes the knex instance or transaction to
// run on, so the service decides the transaction boundary.

/** @typedef {import('knex').Knex} Knex */

const SIGNED_AMOUNT = "CASE e.direction WHEN 'credit' THEN e.amount_kobo ELSE -e.amount_kobo END";

function toAccount(row) {
  return (
    row && {
      id: row.id,
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      currency: row.currency,
      balanceKobo: row.balance_kobo,
      status: row.status,
      createdAt: row.created_at,
    }
  );
}

function toTransaction(row) {
  return (
    row && {
      id: row.id,
      reference: row.reference,
      type: row.type,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      metadata: row.metadata,
      createdAt: row.created_at,
    }
  );
}

function toEntry(row) {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    accountId: row.account_id,
    direction: row.direction,
    amountKobo: row.amount_kobo,
    createdAt: row.created_at,
  };
}

function createLedgerRepository() {
  return {
    /** Create the account if it does not exist, then return it. */
    async findOrCreateAccount(db, { ownerType, ownerId, currency = 'NGN' }) {
      await db('accounts')
        .insert({ owner_type: ownerType, owner_id: ownerId, currency })
        .onConflict(['owner_type', 'owner_id', 'currency'])
        .ignore();
      const row = await db('accounts')
        .where({ owner_type: ownerType, owner_id: ownerId, currency })
        .first();
      return toAccount(row);
    },

    async findAccount(db, { ownerType, ownerId, currency = 'NGN' }) {
      const row = await db('accounts')
        .where({ owner_type: ownerType, owner_id: ownerId, currency })
        .first();
      return toAccount(row) || null;
    },

    async findAccountById(db, id) {
      return toAccount(await db('accounts').where({ id }).first()) || null;
    },

    /**
     * Lock accounts with SELECT ... FOR UPDATE in ascending id order, so two
     * transactions touching the same accounts always queue instead of deadlocking.
     */
    async lockAccounts(trx, ids) {
      const rows = await trx('accounts').whereIn('id', ids).orderBy('id').forUpdate();
      return rows.map(toAccount);
    },

    /**
     * Insert the transaction header. Returns null (instead of raising and
     * aborting the caller's transaction) when the reference or idempotency key
     * is already used.
     */
    async insertTransaction(trx, { reference, type, metadata, idempotencyKey }) {
      const [row] = await trx('transactions')
        .insert({ reference, type, metadata, idempotency_key: idempotencyKey })
        .onConflict()
        .ignore()
        .returning('*');
      return toTransaction(row) || null;
    },

    async findTransactionByReferenceOrKey(db, { reference, idempotencyKey }) {
      const query = db('transactions').where({ reference });
      if (idempotencyKey) query.orWhere({ idempotency_key: idempotencyKey });
      return toTransaction(await query.first()) || null;
    },

    async insertEntries(trx, transactionId, entries) {
      const rows = await trx('ledger_entries')
        .insert(
          entries.map((e) => ({
            transaction_id: transactionId,
            account_id: e.accountId,
            direction: e.direction,
            amount_kobo: e.amountKobo,
          })),
        )
        .returning('*');
      return rows.map(toEntry);
    },

    /** Apply a signed change to the cached balance and return the new balance. */
    async applyBalanceDelta(trx, accountId, deltaKobo) {
      const [row] = await trx('accounts')
        .where({ id: accountId })
        .update({
          balance_kobo: trx.raw('balance_kobo + ?::bigint', [deltaKobo]),
          updated_at: trx.fn.now(),
        })
        .returning('balance_kobo');
      return row.balance_kobo;
    },

    async findEntriesByTransaction(db, transactionId) {
      const rows = await db('ledger_entries')
        .where({ transaction_id: transactionId })
        .orderBy('id');
      return rows.map(toEntry);
    },

    // ---- Audit queries (read-only) -------------------------------------------

    /** SUM(credits) - SUM(debits) over the whole ledger. Must be 0. */
    async ledgerNet(db) {
      const { rows } = await db.raw(
        `SELECT COALESCE(SUM(${SIGNED_AMOUNT}), 0)::bigint AS net FROM ledger_entries e`,
      );
      return rows[0].net;
    },

    /** Accounts whose cached balance differs from their ledger sum. Must be empty. */
    async balanceMismatches(db) {
      const { rows } = await db.raw(`
        SELECT a.id, a.owner_type, a.owner_id, a.balance_kobo,
               COALESCE(SUM(${SIGNED_AMOUNT}), 0)::bigint AS ledger_kobo
          FROM accounts a
          LEFT JOIN ledger_entries e ON e.account_id = a.id
         GROUP BY a.id
        HAVING a.balance_kobo <> COALESCE(SUM(${SIGNED_AMOUNT}), 0)
      `);
      return rows.map((r) => ({
        accountId: r.id,
        ownerType: r.owner_type,
        ownerId: r.owner_id,
        balanceKobo: r.balance_kobo,
        ledgerKobo: r.ledger_kobo,
      }));
    },

    /** Transactions whose entries do not net to zero, or that have fewer than 2 entries. */
    async malformedTransactions(db) {
      const { rows } = await db.raw(`
        SELECT t.id, t.reference, COUNT(e.id)::int AS entry_count,
               COALESCE(SUM(${SIGNED_AMOUNT}), 0)::bigint AS net_kobo
          FROM transactions t
          LEFT JOIN ledger_entries e ON e.transaction_id = t.id
         GROUP BY t.id
        HAVING COUNT(e.id) < 2 OR COALESCE(SUM(${SIGNED_AMOUNT}), 0) <> 0
      `);
      return rows.map((r) => ({
        transactionId: r.id,
        reference: r.reference,
        entryCount: r.entry_count,
        netKobo: r.net_kobo,
      }));
    },

    /** Accounts below zero other than the ones allowed to be (EXTERNAL_PAYSTACK). */
    async negativeAccounts(db, allowedSystemOwnerIds) {
      const rows = await db('accounts')
        .where('balance_kobo', '<', 0)
        .whereNot((q) => q.where('owner_type', 'SYSTEM').whereIn('owner_id', allowedSystemOwnerIds))
        .select('id', 'owner_type', 'owner_id', 'balance_kobo');
      return rows.map((r) => ({
        accountId: r.id,
        ownerType: r.owner_type,
        ownerId: r.owner_id,
        balanceKobo: r.balance_kobo,
      }));
    },
  };
}

module.exports = { createLedgerRepository };
