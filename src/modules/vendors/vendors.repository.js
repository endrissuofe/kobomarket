const { Vendor, VENDOR_STATUS } = require('./vendor.model');

// The only code that queries the vendors collection.
const vendorsRepository = {
  create(fields) {
    return Vendor.create(fields);
  },

  findById(id) {
    return Vendor.findById(id).lean();
  },

  findByUserId(userId) {
    return Vendor.findOne({ userId }).lean();
  },

  slugExists(slug) {
    return Vendor.exists({ slug });
  },

  /** Re-apply after rejection: only a REJECTED application can be replaced. */
  reapply(userId, fields) {
    return Vendor.findOneAndUpdate(
      { userId, status: VENDOR_STATUS.REJECTED },
      {
        $set: {
          ...fields,
          status: VENDOR_STATUS.PENDING,
          rejectionReason: null,
          reviewedBy: null,
          reviewedAt: null,
        },
      },
      { new: true, runValidators: true },
    ).lean();
  },

  /**
   * Move an application from one status to another, atomically. Returns the
   * updated document, or null if it was not in the expected status.
   */
  transition(id, { from, to, reviewedBy, rejectionReason = null, now = new Date() }) {
    return Vendor.findOneAndUpdate(
      { _id: id, status: from },
      { $set: { status: to, reviewedBy, reviewedAt: now, rejectionReason } },
      { new: true },
    ).lean();
  },

  /** Oldest first, keyset-paginated on _id. */
  list({ status, afterId, limit }) {
    const filter = {};
    if (status) filter.status = status;
    if (afterId) filter._id = { $gt: afterId };
    return Vendor.find(filter).sort({ _id: 1 }).limit(limit).lean();
  },
};

module.exports = { vendorsRepository };
