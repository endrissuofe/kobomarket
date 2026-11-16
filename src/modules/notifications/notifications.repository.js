const { Notification } = require('./notification.model');

// The only code that queries the notifications collection.
const notificationsRepository = {
  /**
   * Create notifications, skipping any that already exist for the same user,
   * event and type (a redelivered event). Returns how many were new.
   */
  async createMany(docs) {
    if (docs.length === 0) return 0;
    const res = await Notification.bulkWrite(
      docs.map((doc) => ({
        updateOne: {
          filter: { userId: doc.userId, sourceEventId: doc.sourceEventId, type: doc.type },
          update: { $setOnInsert: doc },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    return res.upsertedCount;
  },

  /** Newest first, keyset on _id. */
  list(userId, { unreadOnly, beforeId, limit }) {
    const filter = { userId };
    if (unreadOnly) filter.readAt = null;
    if (beforeId) filter._id = { $lt: beforeId };
    return Notification.find(filter).sort({ _id: -1 }).limit(limit);
  },

  unreadCount(userId) {
    return Notification.countDocuments({ userId, readAt: null });
  },

  /** Marks one of the user's notifications read (keeps the first readAt). */
  async markRead(userId, id, now = new Date()) {
    const doc = await Notification.findOneAndUpdate(
      { _id: id, userId, readAt: null },
      { $set: { readAt: now } },
      { new: true },
    );
    return doc ?? Notification.findOne({ _id: id, userId });
  },

  async markAllRead(userId, now = new Date()) {
    const res = await Notification.updateMany({ userId, readAt: null }, { $set: { readAt: now } });
    return res.modifiedCount;
  },
};

module.exports = { notificationsRepository };
