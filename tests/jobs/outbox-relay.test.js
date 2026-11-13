process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const postgres = require('../../src/db/postgres');
const { relayOutbox, MAX_ATTEMPTS } = require('../../src/jobs/outbox-relay');

afterAll(() => postgres.close());

const { db } = postgres;
const noop = async () => {};

/** Insert one PENDING event of our own under a unique aggregate id. */
async function event(eventType = 'test.event') {
  const aggregateId = `test-${randomUUID()}`;
  const [row] = await db('outbox_events')
    .insert({
      aggregate: 'test',
      aggregate_id: aggregateId,
      event_type: eventType,
      payload: { aggregateId },
    })
    .returning('*');
  return row;
}
const reload = (id) => db('outbox_events').where({ id }).first();

// Locally there is no worker, so earlier test runs leave PENDING rows behind.
// Relay them first so each test only sees its own rows.
beforeAll(async () => {
  for (let i = 0; i < 1000; i += 1) {
    if ((await relayOutbox({ publish: noop, batchSize: 500 })).sent === 0) break;
  }
}, 300_000);

describe('outbox relay', () => {
  test('publishes due events in id order and marks them SENT', async () => {
    const a = await event('order.placed');
    const b = await event('order.cancelled');
    const published = [];
    await relayOutbox({ publish: async (e) => published.push(e) });

    const ours = published.filter((e) => [a.id, b.id].includes(e.outboxId));
    expect(ours.map((e) => e.eventType)).toEqual(['order.placed', 'order.cancelled']);
    expect(ours[0]).toMatchObject({
      aggregate: 'test',
      aggregateId: a.aggregate_id,
      payload: a.payload,
    });
    expect(await reload(a.id)).toMatchObject({ status: 'SENT', attempts: 0 });
    expect((await reload(a.id)).sent_at).not.toBeNull();
  });

  test('a failed publish backs off and stays PENDING', async () => {
    const e = await event();
    await relayOutbox({
      publish: async (x) => {
        if (x.outboxId === e.id) throw new Error('redis down');
      },
    });
    const after = await reload(e.id);
    expect(after).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'redis down' });
    expect(new Date(after.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    // Not due yet, so the next run leaves it alone.
    const published = [];
    await relayOutbox({ publish: async (x) => published.push(x.outboxId) });
    expect(published).not.toContain(e.id);
  });

  test(`after ${MAX_ATTEMPTS} failed attempts the event is DEAD`, async () => {
    const e = await event();
    await db('outbox_events')
      .where({ id: e.id })
      .update({ attempts: MAX_ATTEMPTS - 1 });
    await relayOutbox({
      publish: async (x) => {
        if (x.outboxId === e.id) throw new Error('still down');
      },
    });
    expect(await reload(e.id)).toMatchObject({ status: 'DEAD', attempts: MAX_ATTEMPTS });
  });

  test('two relays at once never publish the same event twice', async () => {
    const mine = [];
    for (let i = 0; i < 20; i += 1) mine.push((await event()).id);
    const published = [];
    const publish = async (x) => {
      await new Promise((r) => setTimeout(r, 5));
      published.push(x.outboxId);
    };
    await Promise.all([
      relayOutbox({ publish, batchSize: 10 }),
      relayOutbox({ publish, batchSize: 10 }),
    ]);
    await relayOutbox({ publish }); // whatever is left

    const ours = published.filter((id) => mine.includes(id));
    expect(ours.sort()).toEqual([...mine].sort());
    expect(new Set(ours).size).toBe(ours.length);
  });
});
