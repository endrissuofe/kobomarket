require('./src/config/loadEnv');

// The knex CLI (migrate, seed) runs schema changes, so it uses the direct
// connection. On Neon the pooled URL goes through PgBouncer in transaction
// mode, which can break migrations. Falls back to DATABASE_URL locally/Docker.

/** @type {import('knex').Knex.Config} */
const base = {
  client: 'pg',
  connection: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
  pool: { min: 0, max: 5 },
  migrations: { directory: './migrations', tableName: 'knex_migrations' },
  seeds: { directory: './seeds' },
};

module.exports = {
  development: base,
  test: base,
  production: base,
};
