const { Session } = require('./session.model');
const { VerificationToken } = require('./verificationToken.model');
const { LoginAttempt } = require('./loginAttempt.model');

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
};

module.exports = { authRepository, Session, LoginAttempt };
