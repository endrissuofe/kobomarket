// Wallet funding through a payment provider, and the raw log of every webhook.
//
// wallet_fundings: one row per "fund my wallet" request. The provider
// reference is UNIQUE and is also the ledger transaction reference, so a
// payment can credit a wallet at most once.
// webhook_events: every verified webhook, keyed by the provider's event id so
// a redelivered event is recognised and ignored.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE wallet_fundings (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id            TEXT NOT NULL,
      account_id         UUID NOT NULL REFERENCES accounts(id),
      provider           TEXT NOT NULL CHECK (provider IN ('paystack', 'mock')),
      reference          TEXT NOT NULL UNIQUE,
      amount_kobo        BIGINT NOT NULL CHECK (amount_kobo > 0),
      currency           TEXT NOT NULL DEFAULT 'NGN',
      status             TEXT NOT NULL DEFAULT 'INITIATED'
                           CHECK (status IN ('INITIATED', 'SUCCESS', 'FAILED')),
      authorization_url  TEXT,
      transaction_id     UUID REFERENCES transactions(id),
      failure_reason     TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at       TIMESTAMPTZ,
      -- A successful funding always points at the ledger transaction that credited it.
      CONSTRAINT wallet_fundings_success_has_transaction
        CHECK (status <> 'SUCCESS' OR transaction_id IS NOT NULL)
    )
  `);
  await knex.raw(
    'CREATE INDEX wallet_fundings_user_created_idx ON wallet_fundings (user_id, created_at DESC)',
  );

  await knex.raw(`
    CREATE TABLE webhook_events (
      id            BIGSERIAL PRIMARY KEY,
      provider      TEXT NOT NULL,
      event_id      TEXT NOT NULL,
      event_type    TEXT NOT NULL,
      payload       JSONB NOT NULL,
      received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at  TIMESTAMPTZ,
      outcome       TEXT,
      UNIQUE (provider, event_id)
    )
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS webhook_events');
  await knex.raw('DROP TABLE IF EXISTS wallet_fundings');
};
