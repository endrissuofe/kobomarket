// Needs a reachable MongoDB (MONGO_URI). Runs in CI inside the Docker stack,
// and locally against the machine's own mongod.
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { useMongo } = require('../helpers/mongo');

const mongo = useMongo();
afterAll(() => postgres.close());

describe('MongoDB wiring', () => {
  test('readiness check reports both databases ok', async () => {
    const res = await request(createApp()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.data.checks).toEqual({ postgres: 'ok', mongo: 'ok' });
  });

  test('a document written can be read back', async () => {
    const coll = mongo.mongoose.connection.db.collection('_wiring_check');
    const marker = crypto.randomUUID();
    try {
      await coll.insertOne({ marker });
      expect(await coll.findOne({ marker })).toMatchObject({ marker });
    } finally {
      await coll.deleteOne({ marker });
    }
  });
});

describe('readiness without MongoDB', () => {
  test('reports 503 and mongo unreachable when disconnected', async () => {
    await mongo.close();
    try {
      const res = await request(createApp()).get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.data.checks.mongo).toBe('unreachable');
    } finally {
      await mongo.connect();
    }
  });
});
