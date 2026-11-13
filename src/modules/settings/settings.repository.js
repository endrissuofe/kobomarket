// The only code that reads or writes the settings table.
const settingsRepository = {
  /** All settings as { key: value }, read on the given connection or transaction. */
  async getAll(conn) {
    const rows = await conn('settings').select('key', 'value');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
};

module.exports = { settingsRepository };
