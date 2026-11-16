process.env.NODE_ENV = 'test';

const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const postgres = require('../../src/db/postgres');
const { Notification } = require('../../src/modules/notifications/notification.model');
const {
  notificationsFor,
  registerNotificationHandlers,
} = require('../../src/modules/notifications/notifications.handlers');
const {
  notificationsRepository,
} = require('../../src/modules/notifications/notifications.repository');
const { handleEvent } = require('../../src/jobs/event-handlers');
const { relayOutbox } = require('../../src/jobs/outbox-relay');
const { useMongo } = require('../helpers/mongo');
const { signIn } = require('../helpers/auth');
const { shippedSubOrder } = require('../helpers/orders');

useMongo();
afterAll(() => postgres.close());
registerNotificationHandlers();

const app = createApp();
const oid = () =>
  require('mongoose')
    .Types.ObjectId.createFromTime(Date.now() / 1000)
    .toString();
const ev = (eventType, payload) => ({
  outboxId: Math.floor(Math.random() * 1e12),
  eventType,
  payload,
});

describe('notificationsFor (which events notify whom)', () => {
  const buyerId = oid();
  const vendorUserId = oid();

  test.each([
    [
      'order.placed',
      { orderId: 'o1', buyerId, totalKobo: 500000, subOrders: [{ id: 's1', vendorUserId }] },
      [
        [buyerId, 'ORDER_PLACED', '₦5,000.00'],
        [vendorUserId, 'NEW_ORDER', 'new order'],
      ],
    ],
    [
      'order.cancelled',
      { orderId: 'o1', buyerId, refundKobo: 1, subOrders: [{ id: 's1', vendorUserId }] },
      [[vendorUserId, 'ORDER_CANCELLED', 'cancelled']],
    ],
    [
      'sub_order.shipped',
      { subOrderId: 's1', orderId: 'o1', buyerId, courierName: 'GIG', trackingNumber: 'T-9' },
      [[buyerId, 'ORDER_SHIPPED', 'T-9']],
    ],
    [
      'sub_order.funds_released',
      { subOrderId: 's1', orderId: 'o1', vendorUserId, vendorNetKobo: 316667 },
      [[vendorUserId, 'FUNDS_RELEASED', '₦3,166.67']],
    ],
    [
      'dispute.opened',
      { disputeId: 'd1', subOrderId: 's1', buyerId, vendorUserId },
      [[vendorUserId, 'DISPUTE_OPENED', 'dispute']],
    ],
    [
      'dispute.resolved',
      {
        disputeId: 'd1',
        subOrderId: 's1',
        resolution: 'PARTIAL_REFUND',
        refundKobo: 100000,
        buyerId,
        vendorUserId,
      },
      [
        [buyerId, 'DISPUTE_RESOLVED', '₦1,000.00'],
        [vendorUserId, 'DISPUTE_RESOLVED', 'partial refund'],
      ],
    ],
    [
      'payout.succeeded',
      { payoutId: 'p1', vendorUserId, amountKobo: 300000 },
      [[vendorUserId, 'PAYOUT_SUCCEEDED', '₦3,000.00']],
    ],
    [
      'payout.failed',
      { payoutId: 'p1', vendorUserId, amountKobo: 300000, reason: 'bad account' },
      [[vendorUserId, 'PAYOUT_FAILED', 'bad account']],
    ],
  ])('%s', (eventType, payload, expected) => {
    const docs = notificationsFor(ev(eventType, payload));
    expect(docs.map((d) => [d.userId, d.type])).toEqual(expected.map(([u, t]) => [u, t]));
    docs.forEach((d, i) => expect(d.body).toContain(expected[i][2]));
  });

  test('an unknown event creates nothing', () => {
    expect(notificationsFor(ev('something.else', {}))).toEqual([]);
  });
});

describe('handling events', () => {
  test('the same event delivered twice creates one notification per user', async () => {
    const vendor = await signIn(app);
    const event = ev('payout.succeeded', {
      payoutId: randomUUID(),
      vendorUserId: vendor.userId,
      amountKobo: 100000,
    });
    await handleEvent(event);
    await handleEvent(event);
    expect(await Notification.countDocuments({ userId: vendor.userId })).toBe(1);
  });

  test('end to end: checkout, ship and confirm notify buyer and vendor through the outbox', async () => {
    // Relay whatever earlier tests left, so only our events are new below.
    for (let i = 0; i < 200; i += 1) {
      if ((await relayOutbox({ publish: async () => {}, batchSize: 500 })).sent === 0) break;
    }
    const { vendor, buyer, sub } = await shippedSubOrder(app, { priceKobo: 200000 });
    await request(app).patch(`/api/v1/sub-orders/${sub.id}/confirm`).set(buyer.auth);

    for (let i = 0; i < 20; i += 1) {
      if ((await relayOutbox({ publish: handleEvent, batchSize: 500 })).sent === 0) break;
    }

    const typesOf = async (who) =>
      (await request(app).get('/api/v1/notifications').set(who.auth)).body.data.items.map(
        (n) => n.type,
      );
    expect(await typesOf(buyer)).toEqual(['ORDER_SHIPPED', 'ORDER_PLACED']);
    expect(await typesOf(vendor)).toEqual(['FUNDS_RELEASED', 'NEW_ORDER']);
  }, 300_000);
});

describe('notification endpoints', () => {
  async function userWith(count) {
    const user = await signIn(app);
    const docs = Array.from({ length: count }, (_, i) => ({
      userId: user.userId,
      type: 'PAYOUT_SUCCEEDED',
      title: `n${i}`,
      body: 'x',
      sourceEventId: `test-${randomUUID()}`,
    }));
    for (const d of docs) await notificationsRepository.createMany([d]);
    return user;
  }
  const get = (user, query = {}) =>
    request(app).get('/api/v1/notifications').query(query).set(user.auth);

  test('lists newest first with a cursor and the unread count', async () => {
    const user = await userWith(5);
    const titles = [];
    let cursor;
    do {
      const res = await get(user, { limit: 2, ...(cursor && { cursor }) });
      expect(res.body.data.unreadCount).toBe(5);
      titles.push(...res.body.data.items.map((n) => n.title));
      cursor = res.body.data.nextCursor;
    } while (cursor);
    expect(titles).toEqual(['n4', 'n3', 'n2', 'n1', 'n0']);
  });

  test('mark one read (safe to repeat), unread filter, unread count, then read-all', async () => {
    const user = await userWith(3);
    const [first] = (await get(user)).body.data.items;

    const read = await request(app).patch(`/api/v1/notifications/${first.id}/read`).set(user.auth);
    expect(read.status).toBe(200);
    expect(read.body.data.notification.readAt).not.toBeNull();
    const again = await request(app).patch(`/api/v1/notifications/${first.id}/read`).set(user.auth);
    expect(again.body.data.notification.readAt).toBe(read.body.data.notification.readAt);

    expect((await get(user, { unread: 'true' })).body.data.items).toHaveLength(2);
    const count = await request(app).get('/api/v1/notifications/unread-count').set(user.auth);
    expect(count.body.data).toEqual({ unreadCount: 2 });

    const all = await request(app).patch('/api/v1/notifications/read-all').set(user.auth);
    expect(all.body.data).toEqual({ updated: 2 });
    expect((await get(user)).body.data.unreadCount).toBe(0);
  });

  test("someone else's notification is a 404 and stays unread", async () => {
    const owner = await userWith(1);
    const [n] = (await get(owner)).body.data.items;
    const stranger = await signIn(app);
    expect(
      (await request(app).patch(`/api/v1/notifications/${n.id}/read`).set(stranger.auth)).status,
    ).toBe(404);
    expect((await get(owner)).body.data.unreadCount).toBe(1);
  });
});
