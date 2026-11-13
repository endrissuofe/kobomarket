// Needs a reachable Postgres (DATABASE_URL). Runs in CI inside the Docker stack,
// and locally against Neon once .env.local is in place.
process.env.NODE_ENV = 'test';

const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { useMongo } = require('../helpers/mongo');

// Readiness needs both databases up.
useMongo();

afterAll(() => postgres.close());

describe('Postgres wiring', () => {
  test('readiness check reports postgres ok', async () => {
    const res = await request(createApp()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.data.checks.postgres).toBe('ok');
  });

  test('BIGINT kobo values come back as safe integers, not strings', async () => {
    const { rows } = await postgres.db.raw('select 1250000::bigint as amount');
    expect(rows[0].amount).toBe(1250000);
  });

  test('a failed transaction rolls back everything inside it', async () => {
    await postgres.db.raw('create table if not exists _wiring_check (id int primary key)');
    try {
      await expect(
        postgres.withTransaction(async (trx) => {
          await trx('_wiring_check').insert({ id: 1 });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const { rows } = await postgres.db.raw('select count(*)::int as n from _wiring_check');
      expect(rows[0].n).toBe(0);
    } finally {
      await postgres.db.raw('drop table if exists _wiring_check');
    }
  });
});
