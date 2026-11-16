const { User } = require('./user.model');

// The only code that queries the users collection.
const usersRepository = {
  create({ email, passwordHash, name }) {
    return User.create({ email, passwordHash, name });
  },

  findById(id) {
    return User.findById(id);
  },

  /** Includes passwordHash, for login only. */
  findByEmailWithPassword(email) {
    return User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  },

  findByEmail(email) {
    return User.findOne({ email: email.toLowerCase() });
  },

  updateProfile(id, { name }) {
    return User.findByIdAndUpdate(id, { $set: { name } }, { new: true, runValidators: true });
  },

  /** Users whose wallet is still PENDING and were created before `olderThan`. */
  findPendingWallets({ olderThan, limit }) {
    return User.find({ walletStatus: 'PENDING', createdAt: { $lte: olderThan } })
      .sort({ createdAt: 1 })
      .limit(limit)
      .select('_id')
      .lean();
  },

  /**
   * Admin user search, newest first, keyset on _id. q matches the start of the
   * email or any part of the name, case-insensitive (regex-escaped).
   */
  search({ q, role, status, beforeId, limit }) {
    const filter = {};
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ email: new RegExp(`^${safe}`, 'i') }, { name: new RegExp(safe, 'i') }];
    }
    if (role) filter.roles = role;
    if (status) filter.status = status;
    if (beforeId) filter._id = { $lt: beforeId };
    return User.find(filter).sort({ _id: -1 }).limit(limit);
  },

  setFrozen(id, { frozen, by, reason }) {
    const $set = frozen
      ? { status: 'FROZEN', frozenAt: new Date(), frozenBy: by, frozenReason: reason }
      : { status: 'ACTIVE', frozenAt: null, frozenBy: null, frozenReason: null };
    return User.findByIdAndUpdate(id, { $set }, { new: true });
  },

  setWalletStatus(id, walletStatus) {
    return User.updateOne({ _id: id }, { $set: { walletStatus } });
  },

  /** Sets emailVerifiedAt once; a second call leaves the first date alone. */
  markEmailVerified(id, at = new Date()) {
    return User.updateOne({ _id: id, emailVerifiedAt: null }, { $set: { emailVerifiedAt: at } });
  },

  /** Idempotent: adding a role the user already has changes nothing. */
  addRole(id, role) {
    return User.updateOne({ _id: id }, { $addToSet: { roles: role } });
  },

  setPasswordHash(id, passwordHash) {
    return User.updateOne({ _id: id }, { $set: { passwordHash } });
  },
};

module.exports = { usersRepository };
