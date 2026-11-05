// Database-level guards for the ledger, so they hold even if application code
// (or someone with psql) gets it wrong:
//
// 1. Append-only: ledger_entries and transactions refuse UPDATE, DELETE and
//    TRUNCATE. Mistakes are fixed with reversing entries.
// 2. Balanced: at COMMIT, every transaction touched must have
//    SUM(credit) = SUM(debit). The constraint trigger is deferred so all the
//    entries of one transaction can be inserted before the check runs.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE FUNCTION ledger_refuse_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation',
              HINT = 'Post a reversing transaction instead.';
    END;
    $$
  `);

  for (const table of ['ledger_entries', 'transactions']) {
    await knex.raw(`
      CREATE TRIGGER ${table}_no_update_delete
      BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ledger_refuse_change()
    `);
    await knex.raw(`
      CREATE TRIGGER ${table}_no_truncate
      BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION ledger_refuse_change()
    `);
  }

  await knex.raw(`
    CREATE FUNCTION ledger_assert_balanced() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      net BIGINT;
    BEGIN
      SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_kobo ELSE -amount_kobo END), 0)
        INTO net
        FROM ledger_entries
       WHERE transaction_id = NEW.transaction_id;

      IF net <> 0 THEN
        RAISE EXCEPTION 'Ledger transaction % does not balance (credits - debits = % kobo)',
          NEW.transaction_id, net
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NULL;
    END;
    $$
  `);

  await knex.raw(`
    CREATE CONSTRAINT TRIGGER ledger_entries_balanced
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced()
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS ledger_entries_balanced ON ledger_entries');
  await knex.raw('DROP FUNCTION IF EXISTS ledger_assert_balanced()');
  for (const table of ['ledger_entries', 'transactions']) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${table}_no_truncate ON ${table}`);
    await knex.raw(`DROP TRIGGER IF EXISTS ${table}_no_update_delete ON ${table}`);
  }
  await knex.raw('DROP FUNCTION IF EXISTS ledger_refuse_change()');
};
