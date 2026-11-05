// Idempotency-Key storage for checkout, wallet fund and payouts.
// Same key + same body replays the saved response; same key + different body
// is 409 IDEMPOTENCY_KEY_REUSED; IN_PROGRESS is 409 REQUEST_IN_PROGRESS.
// Keys expire after 24 h; a stale IN_PROGRESS row (locked_at older than 60 s)
// may be taken over by a retry.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE idempotency_keys (
      key            TEXT NOT NULL,
      user_id        TEXT NOT NULL,
      endpoint       TEXT NOT NULL,
      request_hash   TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'IN_PROGRESS'
                       CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
      response_code  INTEGER,
      response_body  JSONB,
      locked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at     TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
      PRIMARY KEY (key, user_id, endpoint),
      CONSTRAINT idempotency_keys_completed_has_response
        CHECK (status <> 'COMPLETED' OR response_code IS NOT NULL)
    )
  `);

  // Cleanup job deletes expired keys.
  await knex.raw('CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at)');
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS idempotency_keys');
};
