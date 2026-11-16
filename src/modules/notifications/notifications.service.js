const { notificationsRepository } = require('./notifications.repository');
const { decodeCursor, paginate } = require('../../shared/http/cursor');
const { objectId } = require('../../shared/http/schemas');
const { badRequest, notFound } = require('../../shared/errors');

/** The user's notifications, newest first, with the unread count for the badge. */
async function list(user, { limit, cursor, unread }) {
  const after = decodeCursor(cursor);
  if (after && !objectId.safeParse(after.id).success) throw badRequest('Invalid cursor');
  const [rows, unreadCount] = await Promise.all([
    notificationsRepository.list(user.id, {
      unreadOnly: unread,
      beforeId: after?.id,
      limit: limit + 1,
    }),
    notificationsRepository.unreadCount(user.id),
  ]);
  const page = paginate(rows, limit, (n) => ({ id: String(n._id) }));
  return { items: page.items, nextCursor: page.nextCursor, unreadCount };
}

async function unreadCount(user) {
  return { unreadCount: await notificationsRepository.unreadCount(user.id) };
}

/** Safe to repeat. Someone else's notification is a 404. */
async function markRead(user, id) {
  const doc = await notificationsRepository.markRead(user.id, id);
  if (!doc) throw notFound('Notification');
  return doc;
}

async function markAllRead(user) {
  return { updated: await notificationsRepository.markAllRead(user.id) };
}

module.exports = { notificationsService: { list, unreadCount, markRead, markAllRead } };
