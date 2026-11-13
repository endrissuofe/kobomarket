// Transactional outbox: rows written in the same transaction as the business
// change, relayed later by the worker. The only code that writes outbox_events.
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
};

const OUTBOX_EVENTS = Object.freeze({
  ORDER_PLACED: 'order.placed',
  ORDER_CANCELLED: 'order.cancelled',
  SUB_ORDER_SHIPPED: 'sub_order.shipped',
  FUNDS_RELEASED: 'sub_order.funds_released',
});

module.exports = { outboxRepository, OUTBOX_EVENTS };
