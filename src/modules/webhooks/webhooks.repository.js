const { db } = require('../../db/postgres');

// The only code that touches webhook_events.
const webhooksRepository = {
  /**
   * Log the event. A redelivery of the same event id returns the existing row,
   * so the caller can tell whether it was already processed.
   */
  async record({ provider, eventId, eventType, payload }) {
    const { rows } = await db.raw(
      `INSERT INTO webhook_events (provider, event_id, event_type, payload)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (provider, event_id) DO UPDATE SET provider = EXCLUDED.provider
       RETURNING id, processed_at`,
      [provider, eventId, eventType, JSON.stringify(payload)],
    );
    return rows[0];
  },

  markProcessed(id, outcome) {
    return db('webhook_events').where({ id }).update({ processed_at: db.fn.now(), outcome });
  },
};

module.exports = { webhooksRepository };
