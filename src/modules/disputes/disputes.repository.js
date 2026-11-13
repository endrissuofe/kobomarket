// The only code that touches the disputes table. Functions take the knex
// instance or a transaction.

function toDispute(row) {
  return (
    row && {
      id: row.id,
      subOrderId: row.sub_order_id,
      buyerId: row.buyer_id,
      reason: row.reason,
      evidence: row.evidence,
      vendorResponse: row.vendor_response,
      vendorEvidence: row.vendor_evidence,
      vendorRespondedAt: row.vendor_responded_at,
      status: row.status,
      resolution: row.resolution,
      refundKobo: row.refund_kobo,
      resolvedBy: row.resolved_by,
      note: row.note,
      resolutionTxnId: row.resolution_txn_id,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
      ...(row.created_at_text && { cursorTime: row.created_at_text }),
      ...(row.vendor_id && { vendorId: row.vendor_id, vendorUserId: row.vendor_user_id }),
    }
  );
}

const withVendor = (conn) =>
  conn('disputes as d')
    .join('sub_orders as s', 's.id', 'd.sub_order_id')
    .select(
      'd.*',
      's.vendor_id',
      's.vendor_user_id',
      conn.raw('d.created_at::text AS created_at_text'),
    );

const disputesRepository = {
  async insert(trx, { subOrderId, buyerId, reason, evidence }) {
    const [row] = await trx('disputes')
      .insert({
        sub_order_id: subOrderId,
        buyer_id: buyerId,
        reason,
        evidence: JSON.stringify(evidence),
      })
      .returning('*');
    return toDispute(row);
  },

  async find(conn, id) {
    return toDispute(await withVendor(conn).where('d.id', id).first());
  },

  /** Lock the dispute row for the rest of the transaction. */
  async lock(trx, id) {
    return toDispute(await trx('disputes').where({ id }).forUpdate().first());
  },

  /** Store the vendor's one reply; only while OPEN and not yet answered. */
  async saveVendorResponse(conn, id, { response, evidence }) {
    const [row] = await conn('disputes')
      .where({ id, status: 'OPEN' })
      .whereNull('vendor_response')
      .update({
        vendor_response: response,
        vendor_evidence: JSON.stringify(evidence),
        vendor_responded_at: conn.fn.now(),
      })
      .returning('*');
    return toDispute(row);
  },

  async resolve(trx, id, { resolution, refundKobo, resolvedBy, note, txnId }) {
    const [row] = await trx('disputes')
      .where({ id, status: 'OPEN' })
      .update({
        status: 'RESOLVED',
        resolution,
        refund_kobo: refundKobo,
        resolved_by: resolvedBy,
        note,
        resolution_txn_id: txnId,
        resolved_at: trx.fn.now(),
      })
      .returning('*');
    return toDispute(row);
  },

  /** Newest first, keyset on (created_at, id); filters by status or participant. */
  async list(conn, { status, participantId, after, limit }) {
    const query = withVendor(conn)
      .orderBy([
        { column: 'd.created_at', order: 'desc' },
        { column: 'd.id', order: 'desc' },
      ])
      .limit(limit);
    if (status) query.where('d.status', status);
    if (participantId) {
      query.where((q) =>
        q.where('d.buyer_id', participantId).orWhere('s.vendor_user_id', participantId),
      );
    }
    if (after)
      query.whereRaw('(d.created_at, d.id) < (?::timestamptz, ?::uuid)', [after.t, after.id]);
    return (await query).map(toDispute);
  },
};

module.exports = { disputesRepository };
