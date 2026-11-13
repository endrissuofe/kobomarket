// Vendor payouts. Requesting one moves the money out of the vendor wallet
// into PLATFORM_PAYOUT_CLEARING at once (PAYOUT_HOLD); a worker then sends
// the transfer and settles it (PAYOUT_SETTLE to EXTERNAL_PAYSTACK) or returns
// it (PAYOUT_REVERSAL to the vendor wallet).

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE payouts (
      id                   UUID PRIMARY KEY,           -- set by the app; also the transfer reference
      vendor_id            TEXT NOT NULL,              -- Mongo vendors._id
      vendor_user_id       TEXT NOT NULL,              -- owner of the wallet
      account_id           UUID NOT NULL REFERENCES accounts(id),
      amount_kobo          BIGINT NOT NULL CHECK (amount_kobo > 0),
      status               TEXT NOT NULL DEFAULT 'PENDING'
                             CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
      -- Where the money went, as it was when the payout was requested.
      bank_code            TEXT NOT NULL,
      account_number       TEXT NOT NULL,
      account_name         TEXT NOT NULL,
      provider             TEXT NOT NULL CHECK (provider IN ('paystack', 'mock')),
      provider_ref         TEXT,
      failure_reason       TEXT,
      idempotency_key      TEXT,
      attempts             INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      claimed_until        TIMESTAMPTZ,                -- processor lease
      hold_txn_id          UUID NOT NULL REFERENCES transactions(id),
      settle_txn_id        UUID REFERENCES transactions(id),
      reversal_txn_id      UUID REFERENCES transactions(id),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at         TIMESTAMPTZ,
      UNIQUE (vendor_user_id, idempotency_key),
      CONSTRAINT payouts_success_settled CHECK (status <> 'SUCCESS' OR settle_txn_id IS NOT NULL),
      CONSTRAINT payouts_failed_reversed CHECK (status <> 'FAILED' OR reversal_txn_id IS NOT NULL)
    )
  `);
  // A vendor can have at most one PENDING payout at a time.
  await knex.raw(`
    CREATE UNIQUE INDEX payouts_one_pending_per_vendor
    ON payouts (vendor_id) WHERE status = 'PENDING'
  `);
  await knex.raw(
    'CREATE INDEX payouts_vendor_created_idx ON payouts (vendor_id, created_at DESC, id DESC)',
  );
  await knex.raw(
    `CREATE INDEX payouts_pending_idx ON payouts (created_at) WHERE status = 'PENDING'`,
  );
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS payouts');
};
