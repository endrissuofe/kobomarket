// The only code that reads or writes the settings table.
const settingsRepository = {
  /** All settings as { key: value }, read on the given connection or transaction. */
  async getAll(conn) {
    const rows = await conn('settings').select('key', 'value');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  async set(conn, key, value, updatedBy) {
    await conn('settings')
      .insert({
        key,
        value: JSON.stringify(value),
        updated_by: updatedBy,
        updated_at: conn.fn.now(),
      })
      .onConflict('key')
      .merge();
  },
};

module.exports = { settingsRepository };
