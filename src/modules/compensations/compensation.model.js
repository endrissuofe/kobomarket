const { Schema, model } = require('mongoose');

// A clean-up step that failed and must be retried, e.g. putting stock back
// after a checkout's Postgres transaction failed. The reconciler job retries
// PENDING ones; after too many attempts they show up for an admin.
const COMPENSATION_TYPES = Object.freeze({ STOCK_RELEASE: 'STOCK_RELEASE' });
const COMPENSATION_STATUS = Object.freeze({ PENDING: 'PENDING', DONE: 'DONE', DEAD: 'DEAD' });

const compensationSchema = new Schema(
  {
    type: { type: String, enum: Object.values(COMPENSATION_TYPES), required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    reason: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(COMPENSATION_STATUS),
      default: COMPENSATION_STATUS.PENDING,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
  },
  { timestamps: true, collection: 'compensations' },
);

compensationSchema.index({ status: 1, updatedAt: 1 });

module.exports = {
  Compensation: model('Compensation', compensationSchema),
  COMPENSATION_TYPES,
  COMPENSATION_STATUS,
};
