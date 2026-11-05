// Double-entry ledger. One transactions row per business event, two or more
// ledger_entries rows that net to zero. Sign convention: a credit increases
// an account's balance, a debit decreases it.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE transactions (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      reference        TEXT NOT NULL UNIQUE,
      type             TEXT NOT NULL CHECK (type IN (
                         'FUNDING', 'ESCROW_HOLD', 'ESCROW_RELEASE', 'REFUND',
                         'PAYOUT_HOLD', 'PAYOUT_SETTLE', 'PAYOUT_REVERSAL')),
      status           TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED')),
      idempotency_key  TEXT UNIQUE,
      metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await knex.raw(`
    CREATE TABLE ledger_entries (
      id              BIGSERIAL PRIMARY KEY,
      transaction_id  UUID NOT NULL REFERENCES transactions(id),
      account_id      UUID NOT NULL REFERENCES accounts(id),
      direction       TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
      amount_kobo     BIGINT NOT NULL CHECK (amount_kobo > 0),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Wallet history (statement) and per-account reconciliation.
  await knex.raw(
    'CREATE INDEX ledger_entries_account_created_idx ON ledger_entries (account_id, created_at)',
  );
  // Balanced-transaction check and transaction detail look-ups.
  await knex.raw('CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id)');
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS ledger_entries');
  await knex.raw('DROP TABLE IF EXISTS transactions');
};
