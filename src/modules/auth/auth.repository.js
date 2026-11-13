const { Session } = require('./session.model');
const { VerificationToken } = require('./verificationToken.model');
const { LoginAttempt, LOGIN_WINDOW_SECONDS } = require('./loginAttempt.model');

// The only code that queries sessions, verification tokens and login attempts.
const authRepository = {
  // --- Verification / reset tokens ---

  createVerificationToken({ userId, type, tokenHash, expiresAt }) {
    return VerificationToken.create({ userId, type, tokenHash, expiresAt });
  },

  /** Marks a valid token used and returns it; null if unknown, used or expired. */
  consumeVerificationToken({ tokenHash, type, now = new Date() }) {
    return VerificationToken.findOneAndUpdate(
      { tokenHash, type, usedAt: null, expiresAt: { $gt: now } },
      { $set: { usedAt: now } },
      { new: true },
    );
  },

  /** Retire earlier unused tokens of a type, e.g. when a new reset link is sent. */
  expireUnusedTokens({ userId, type, now = new Date() }) {
    return VerificationToken.updateMany({ userId, type, usedAt: null }, { $set: { usedAt: now } });
  },

  // --- Login attempts (rate limit) ---

  /**
   * Count one login attempt for this key and return the document after the
   * update. One atomic pipeline update: if the 15-minute window has passed it
   * restarts at 1, otherwise it adds 1. Counting before the password check
   * means parallel guesses cannot all slip under the limit.
   */
  async recordLoginAttempt({ key, now = new Date(), windowSeconds = LOGIN_WINDOW_SECONDS }) {
    const cutoff = new Date(now.getTime() - windowSeconds * 1000);
    const windowOver = {
      $or: [
        { $eq: [{ $ifNull: ['$windowStart', null] }, null] },
        { $lt: ['$windowStart', cutoff] },
      ],
    };
    const update = [
      {
        $set: {
          windowStart: { $cond: [windowOver, now, '$windowStart'] },
          count: { $cond: [windowOver, 1, { $add: ['$count', 1] }] },
        },
      },
    ];
    const run = () =>
      LoginAttempt.findOneAndUpdate({ key }, update, { upsert: true, new: true }).lean();
    try {
      return await run();
    } catch (err) {
      // Two first attempts at once: one upsert wins, the other retries as an update.
      if (err.code === 11000) return run();
      throw err;
    }
  },

  clearLoginAttempts(key) {
    return LoginAttempt.deleteOne({ key });
  },

  // --- Sessions (refresh tokens) ---

  createSession({ userId, familyId, tokenHash, expiresAt, ip, userAgent }) {
    return Session.create({ userId, familyId, tokenHash, expiresAt, ip, userAgent });
  },
};

module.exports = { authRepository, Session, LoginAttempt };
