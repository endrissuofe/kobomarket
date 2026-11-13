const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');

const JWT_ALGORITHM = 'HS256';

/** 32 random bytes, URL-safe. Used for refresh, verification and reset tokens. */
function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Tokens are stored only as SHA-256 hashes. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signAccessToken({ userId, roles, sessionFamilyId }) {
  return jwt.sign({ roles, sid: sessionFamilyId }, config.auth.accessSecret, {
    algorithm: JWT_ALGORITHM,
    subject: String(userId),
    expiresIn: config.auth.accessTtl,
  });
}

/** Throws jsonwebtoken errors (TokenExpiredError, JsonWebTokenError). */
function verifyAccessToken(token) {
  return jwt.verify(token, config.auth.accessSecret, { algorithms: [JWT_ALGORITHM] });
}

module.exports = { randomToken, hashToken, signAccessToken, verifyAccessToken };
