const { Schema, model } = require('mongoose');

const NOTIFICATION_TYPES = Object.freeze({
  ORDER_PLACED: 'ORDER_PLACED',
  NEW_ORDER: 'NEW_ORDER',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_SHIPPED: 'ORDER_SHIPPED',
  FUNDS_RELEASED: 'FUNDS_RELEASED',
  DISPUTE_OPENED: 'DISPUTE_OPENED',
  DISPUTE_RESOLVED: 'DISPUTE_RESOLVED',
  PAYOUT_SUCCEEDED: 'PAYOUT_SUCCEEDED',
  PAYOUT_FAILED: 'PAYOUT_FAILED',
});

// In-app notifications, created by the worker from outbox events. Text only:
// amounts in the body are formatted for display; the money itself lives in
// Postgres. sourceEventId is the outbox id: with the unique index below, a
// redelivered event cannot notify the same user twice.
const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: Object.values(NOTIFICATION_TYPES), required: true },
    title: { type: String, required: true, maxlength: 140 },
    body: { type: String, required: true, maxlength: 1000 },
    data: { type: Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null },
    sourceEventId: { type: String, required: true },
  },
  { timestamps: true, collection: 'notifications' },
);

notificationSchema.index({ userId: 1, sourceEventId: 1, type: 1 }, { unique: true });
// List (newest first), unread filter and unread count.
notificationSchema.index({ userId: 1, readAt: 1, _id: -1 });
notificationSchema.index({ userId: 1, _id: -1 });

notificationSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = { Notification: model('Notification', notificationSchema), NOTIFICATION_TYPES };
