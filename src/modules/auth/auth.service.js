const argon2 = require('argon2');

const mailer = require('../../integrations/email');
const { usersRepository } = require('../users/users.repository');
const { usersService } = require('../users/users.service');
const { authRepository } = require('./auth.repository');
const { TOKEN_TYPES } = require('./verificationToken.model');
const { randomToken, hashToken } = require('./auth.tokens');
const { AppError, conflict } = require('../../shared/errors');

const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const ARGON2_OPTIONS = { type: argon2.argon2id };

const invalidToken = () =>
  new AppError('INVALID_TOKEN', 'This link is invalid or has expired', 400);

/** Create a one-time token, store its hash, and email the raw token. */
async function issueEmailToken(user, type, ttlMs) {
  const token = randomToken();
  await authRepository.createVerificationToken({
    userId: user._id,
    type,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return token;
}

async function sendVerificationEmail(user) {
  const token = await issueEmailToken(user, TOKEN_TYPES.EMAIL, EMAIL_TOKEN_TTL_MS);
  await mailer.send({
    to: user.email,
    subject: 'Verify your KoboMarket email',
    text:
      `Your verification token (valid 24 hours):\n${token}\n\n` +
      `POST /api/v1/auth/verify-email with {"token": "<token>"}`,
  });
}

/**
 * Create the Mongo user, open their Postgres wallet, send the verification email.
 * Wallet failure does not fail registration: the user stays walletStatus PENDING
 * and the reconciler retries (see users.service provisionWallet).
 */
async function register({ email, password, name }) {
  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

  let user;
  try {
    user = await usersRepository.create({ email, passwordHash, name });
  } catch (err) {
    if (err.code === 11000)
      throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    throw err;
  }

  await usersService.provisionWallet(user._id);
  await sendVerificationEmail(user);

  return usersRepository.findById(user._id);
}

async function verifyEmail({ token }) {
  const record = await authRepository.consumeVerificationToken({
    tokenHash: hashToken(token),
    type: TOKEN_TYPES.EMAIL,
  });
  if (!record) throw invalidToken();
  await usersRepository.markEmailVerified(record.userId);
  return usersRepository.findById(record.userId);
}

module.exports = { authService: { register, verifyEmail } };
