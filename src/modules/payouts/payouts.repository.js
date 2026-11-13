// The only code that touches the payouts table. Functions take the knex
// instance or a transaction.

const mask = (n) => `******${String(n).slice(-4)}`;

function toPayout(row) {
  return (
    row && {
      id: row.id,
      vendorId: row.vendor_id,
      vendorUserId: row.vendor_user_id,
      accountId: row.account_id,
      amountKobo: row.amount_kobo,
      status: row.status,
      bank: {
        bankCode: row.bank_code,
        accountNumber: row.account_number,
        accountName: row.account_name,
      },
      provider: row.provider,
      providerRef: row.provider_ref,
      failureReason: row.failure_reason,
      attempts: row.attempts,
      holdTxnId: row.hold_txn_id,
      settleTxnId: row.settle_txn_id,
      reversalTxnId: row.reversal_txn_id,
      createdAt: row.created_at,
      processedAt: row.processed_at,
      ...(row.created_at_text && { cursorTime: row.created_at_text }),
    }
  );
}

/** What the vendor sees: no internal ids, account number masked. */
function toView(p) {
  return {
    id: p.id,
    amountKobo: p.amountKobo,
    status: p.status,
    bank: { ...p.bank, accountNumber: mask(p.bank.accountNumber) },
    providerRef: p.providerRef,
    failureReason: p.failureReason,
    createdAt: p.createdAt,
    processedAt: p.processedAt,
  };
}

const payoutsRepository = {
  async insert(trx, p) {
    const [row] = await trx('payouts')
      .insert({
        id: p.id,
        vendor_id: p.vendorId,
        vendor_user_id: p.vendorUserId,
        account_id: p.accountId,
        amount_kobo: p.amountKobo,
        bank_code: p.bank.bankCode,
        account_number: p.bank.accountNumber,
        account_name: p.bank.accountName,
        provider: p.provider,
        idempotency_key: p.idempotencyKey ?? null,
        hold_txn_id: p.holdTxnId,
      })
      .returning('*');
    return toPayout(row);
  },

  async hasPending(conn, vendorId) {
    return Boolean(
      await conn('payouts').where({ vendor_id: vendorId, status: 'PENDING' }).first('id'),
    );
  },

  async find(conn, id) {
    return toPayout(await conn('payouts').where({ id }).first());
  },

  /** Vendor's payouts, newest first, keyset on (created_at, id). */
  async listForVendor(conn, vendorId, { after, limit }) {
    const query = conn('payouts')
      .where({ vendor_id: vendorId })
      .select('*', conn.raw('created_at::text AS created_at_text'))
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(limit);
    if (after) query.whereRaw('(created_at, id) < (?::timestamptz, ?::uuid)', [after.t, after.id]);
    return (await query).map(toPayout);
  },

  // --- Processor ---

  /**
   * Claim up to `limit` PENDING payouts not leased by another worker: lock
   * (SKIP LOCKED), set a lease and count the attempt, in one short
   * transaction. The transfer happens after commit.
   */
  async claimPending(db, { limit, leaseSeconds }) {
    return db.transaction(async (trx) => {
      const rows = await trx('payouts')
        .where({ status: 'PENDING' })
        .where((q) => q.whereNull('claimed_until').orWhere('claimed_until', '<=', trx.fn.now()))
        .orderBy('created_at')
        .limit(limit)
        .forUpdate()
        .skipLocked();
      if (rows.length === 0) return [];
      const claimed = await trx('payouts')
        .whereIn(
          'id',
          rows.map((r) => r.id),
        )
        .update({
          claimed_until: trx.raw('now() + make_interval(secs => ?)', [leaseSeconds]),
          attempts: trx.raw('attempts + 1'),
        })
        .returning('*');
      return claimed.map(toPayout);
    });
  },

  /** Lock one payout for the rest of the transaction. */
  async lock(trx, id) {
    return toPayout(await trx('payouts').where({ id }).forUpdate().first());
  },

  async finish(trx, id, fields) {
    await trx('payouts')
      .where({ id, status: 'PENDING' })
      .update({ ...fields, processed_at: trx.fn.now(), claimed_until: null });
  },

  /** Provider still working on it: record its ref and try again after a pause. */
  async postpone(conn, id, { providerRef, seconds }) {
    await conn('payouts')
      .where({ id, status: 'PENDING' })
      .update({
        provider_ref: providerRef,
        claimed_until: conn.raw('now() + make_interval(secs => ?)', [seconds]),
      });
  },
};

module.exports = { payoutsRepository, toView };
