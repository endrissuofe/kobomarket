const knex = require('knex');
const { types } = require('pg');
const config = require('../config');

// BIGINT (money in kobo) comes back from pg as a string to avoid precision loss.
// Parse it to a JS number and refuse anything outside the safe integer range.
types.setTypeParser(types.builtins.INT8, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`BIGINT out of safe range: ${value}`);
  return n;
});

// App queries use the pooled connection string (Neon PgBouncer).
// A long-running Express server keeps this one pool for its whole life.
const db = knex({
  client: 'pg',
  connection: config.databaseUrl,
  pool: { min: 0, max: 10 },
  acquireConnectionTimeout: 10000,
});

/** Run fn inside one transaction. Commits on success, rolls back on throw. */
function withTransaction(fn) {
  return db.transaction(fn);
}

/** Cheap round-trip used by the readiness check. */
async function ping() {
  await db.raw('select 1');
}

async function close() {
  await db.destroy();
}

module.exports = { db, withTransaction, ping, close };
