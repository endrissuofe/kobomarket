// Wallets and system accounts. Money is integer kobo in BIGINT.
// balance_kobo is a cache of SUM(credits) - SUM(debits) from ledger_entries;
// only the ledger module writes it, and audit:ledger checks it matches.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE accounts (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_type    TEXT NOT NULL CHECK (owner_type IN ('USER', 'SYSTEM')),
      owner_id      TEXT NOT NULL,
      currency      CHAR(3) NOT NULL DEFAULT 'NGN',
      balance_kobo  BIGINT NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT accounts_owner_currency_unique UNIQUE (owner_type, owner_id, currency),
      -- A user wallet can never go negative, even if two requests race.
      CONSTRAINT accounts_user_balance_non_negative
        CHECK (owner_type = 'SYSTEM' OR balance_kobo >= 0)
    )
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS accounts');
};
