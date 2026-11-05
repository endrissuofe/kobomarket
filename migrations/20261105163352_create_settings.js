// Admin-editable business settings. Env vars only give first-boot defaults;
// the live values are read from here. Commission is snapshotted onto each
// sub-order at checkout, so a change applies to new orders only.

const DEFAULTS = {
  commission_bps: 500, // 5%
  escrow_timeout_hours: 72,
  payout_min_kobo: 100000, // ₦1,000
};

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE settings (
      key         TEXT PRIMARY KEY,
      value       JSONB NOT NULL,
      updated_by  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await knex('settings')
    .insert(Object.entries(DEFAULTS).map(([key, value]) => ({ key, value: JSON.stringify(value) })))
    .onConflict('key')
    .ignore();
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS settings');
};
