require('./src/config/loadEnv');

// The knex CLI (migrate, seed) runs schema changes, so it uses the direct
// connection. On Neon the pooled URL goes through PgBouncer in transaction
// mode, which can break migrations. Falls back to DATABASE_URL locally/Docker.

const connection = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connection) {
  // Without this, pg silently tries localhost:5432 and knex only says
  // "Unable to acquire a connection".
  throw new Error(
    'No database URL found. Run `neon env pull --project-id curly-resonance-15703720 --branch production` ' +
      'to create .env.local, or set DATABASE_URL in .env.',
  );
}

/** @type {import('knex').Knex.Config} */
const base = {
  client: 'pg',
  connection,
  pool: { min: 0, max: 5 },
  migrations: { directory: './migrations', tableName: 'knex_migrations' },
  seeds: { directory: './seeds' },
};

module.exports = {
  development: base,
  test: base,
  production: base,
};
