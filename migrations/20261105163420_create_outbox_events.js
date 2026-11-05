// Transactional outbox. Rows are written in the same Postgres transaction as
// the money change; a worker relays them (FOR UPDATE SKIP LOCKED), marks them
// SENT, and after too many failures DEAD (shown on the admin dashboard).

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE outbox_events (
      id               BIGSERIAL PRIMARY KEY,
      aggregate        TEXT NOT NULL,         -- e.g. 'order', 'sub_order', 'payout'
      aggregate_id     TEXT NOT NULL,
      event_type       TEXT NOT NULL,         -- e.g. 'order.paid'
      payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
      status           TEXT NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'SENT', 'DEAD')),
      attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error       TEXT,
      next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at          TIMESTAMPTZ
    )
  `);

  // The relay only ever scans due PENDING rows; keep that index small.
  await knex.raw(`
    CREATE INDEX outbox_events_pending_due_idx
    ON outbox_events (next_attempt_at, id)
    WHERE status = 'PENDING'
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS outbox_events');
};
