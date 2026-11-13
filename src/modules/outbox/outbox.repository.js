// Transactional outbox: rows written in the same transaction as the business
// change, relayed later by the worker. The only code that touches outbox_events.
const outboxRepository = {
  /** @param {import('knex').Knex.Transaction} trx */
  async add(trx, { aggregate, aggregateId, eventType, payload }) {
    await trx('outbox_events').insert({
      aggregate,
      aggregate_id: String(aggregateId),
      event_type: eventType,
      payload: JSON.stringify(payload),
    });
  },

  /**
   * Claim up to `limit` due PENDING rows: lock them (SKIP LOCKED, so two
   * relays never take the same row) and push next_attempt_at out by the
   * lease, in one short transaction. The caller publishes after commit; if
   * it dies, the lease expires and the rows are claimed again.
   */
  async claimDue(db, { limit, leaseSeconds }) {
    return db.transaction(async (trx) => {
      const rows = await trx('outbox_events')
        .where({ status: 'PENDING' })
        .where('next_attempt_at', '<=', trx.fn.now())
        .orderBy('id')
        .limit(limit)
        .forUpdate()
        .skipLocked();
      if (rows.length === 0) return [];
      await trx('outbox_events')
        .whereIn(
          'id',
          rows.map((r) => r.id),
        )
        .update({ next_attempt_at: trx.raw('now() + make_interval(secs => ?)', [leaseSeconds]) });
      return rows;
    });
  },

  markSent(db, id) {
    return db('outbox_events')
      .where({ id, status: 'PENDING' })
      .update({ status: 'SENT', sent_at: db.fn.now() });
  },

  /** One more failed attempt: back off 2^attempts seconds (max 1 h); DEAD at maxAttempts. */
  markFailed(db, id, error, maxAttempts) {
    return db('outbox_events')
      .where({ id, status: 'PENDING' })
      .update({
        attempts: db.raw('attempts + 1'),
        last_error: String(error).slice(0, 1000),
        next_attempt_at: db.raw(
          'now() + make_interval(secs => least(power(2, attempts + 1), 3600))',
        ),
        status: db.raw("CASE WHEN attempts + 1 >= ? THEN 'DEAD' ELSE 'PENDING' END", [maxAttempts]),
      });
  },
};

const OUTBOX_EVENTS = Object.freeze({
  ORDER_PLACED: 'order.placed',
  ORDER_CANCELLED: 'order.cancelled',
  SUB_ORDER_SHIPPED: 'sub_order.shipped',
  FUNDS_RELEASED: 'sub_order.funds_released',
  DISPUTE_OPENED: 'dispute.opened',
  DISPUTE_RESOLVED: 'dispute.resolved',
});

module.exports = { outboxRepository, OUTBOX_EVENTS };
