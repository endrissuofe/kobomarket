const { Compensation, COMPENSATION_STATUS } = require('./compensation.model');

// The only code that queries the compensations collection.
const compensationsRepository = {
  record({ type, payload, reason, error }) {
    return Compensation.create({ type, payload, reason, lastError: error ?? null });
  },

  /** Atomically claim the oldest PENDING compensation not leased by another worker. */
  claimNext({ leaseSeconds, now = new Date() }) {
    return Compensation.findOneAndUpdate(
      {
        status: COMPENSATION_STATUS.PENDING,
        $or: [{ claimedUntil: null }, { claimedUntil: { $lte: now } }],
      },
      { $set: { claimedUntil: new Date(now.getTime() + leaseSeconds * 1000) } },
      { sort: { updatedAt: 1 }, new: true },
    ).lean();
  },

  markDone(id) {
    return Compensation.updateOne(
      { _id: id },
      { $set: { status: COMPENSATION_STATUS.DONE, claimedUntil: null } },
    );
  },

  /**
   * One more failed attempt. The lease becomes a back-off (30 s x 2^attempts,
   * max 1 h) so the same run does not retry it straight away; DEAD (left for
   * an admin) at maxAttempts.
   */
  async markFailed(id, error, maxAttempts) {
    const doc = await Compensation.findOneAndUpdate(
      { _id: id },
      { $inc: { attempts: 1 } },
      { new: true },
    );
    if (!doc) return;
    const backoffMs = Math.min(30_000 * 2 ** doc.attempts, 3_600_000);
    await Compensation.updateOne(
      { _id: id },
      { $set: { lastError: error, claimedUntil: new Date(Date.now() + backoffMs) } },
    );
    if (doc && doc.attempts >= maxAttempts) {
      await Compensation.updateOne({ _id: id }, { $set: { status: COMPENSATION_STATUS.DEAD } });
    }
  },
};

module.exports = { compensationsRepository };
