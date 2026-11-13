const { randomUUID } = require('node:crypto');
const argon2 = require('argon2');

const config = require('../../config');
const { logger } = require('../../shared/logger');

const mailer = require('../../integrations/email');
const { usersRepository } = require('../users/users.repository');
const { usersService } = require('../users/users.service');
const { authRepository } = require('./auth.repository');
const { TOKEN_TYPES } = require('./verificationToken.model');
const { randomToken, hashToken, signAccessToken } = require('./auth.tokens');
const { LOGIN_WINDOW_SECONDS } = require('./loginAttempt.model');
const {
  AppError,
  conflict,
  unauthorized,
  forbidden,
  tooManyRequests,
} = require('../../shared/errors');

const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const ARGON2_OPTIONS = { type: argon2.argon2id };
const MAX_LOGIN_ATTEMPTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

// Verified against when the email is unknown, so a wrong email takes as long
// as a wrong password and response time does not reveal which emails exist.
let dummyHashPromise;
const dummyHash = () => (dummyHashPromise ??= argon2.hash(randomToken(), ARGON2_OPTIONS));

const invalidRefreshToken = () =>
  unauthorized('Refresh token is invalid or has expired', 'INVALID_REFRESH_TOKEN');

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

/** Start a new session row for this refresh token and sign an access token. */
async function issueTokens(user, { familyId, ip, userAgent }) {
  const refreshToken = randomToken();
  await authRepository.createSession({
    userId: user._id,
    familyId,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + config.auth.refreshTtlDays * DAY_MS),
    ip,
    userAgent,
  });
  const accessToken = signAccessToken({
    userId: user._id,
    roles: user.roles,
    sessionFamilyId: familyId,
  });
  return {
    tokenType: 'Bearer',
    accessToken,
    accessTokenExpiresIn: config.auth.accessTtl,
    refreshToken,
  };
}

/**
 * Rate limit: at most 5 attempts per email + IP in 15 minutes. A successful
 * password check clears the counter, so in effect only failures count.
 * Email verification is checked after the password, so an unverified account
 * is only revealed to someone who knows its password.
 */
async function login({ email, password }, { ip, userAgent } = {}) {
  const key = `${email}|${ip}`;
  const attempt = await authRepository.recordLoginAttempt({ key });
  if (attempt.count > MAX_LOGIN_ATTEMPTS) {
    const retryAt = attempt.windowStart.getTime() + LOGIN_WINDOW_SECONDS * 1000;
    throw tooManyRequests('Too many login attempts. Try again later.', {
      retryAfterSeconds: Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)),
    });
  }

  const user = await usersRepository.findByEmailWithPassword(email);
  const passwordOk = user
    ? await argon2.verify(user.passwordHash, password)
    : (await argon2.verify(await dummyHash(), password), false);
  if (!passwordOk) throw unauthorized('Email or password is incorrect', 'INVALID_CREDENTIALS');

  await authRepository.clearLoginAttempts(key);

  if (!user.emailVerifiedAt) {
    throw forbidden('Verify your email before logging in', 'EMAIL_NOT_VERIFIED');
  }

  const tokens = await issueTokens(user, { familyId: randomUUID(), ip, userAgent });
  return { ...tokens, user: await usersRepository.findById(user._id) };
}

/** A rotated-out token came back: assume it was stolen and end every session. */
async function handleReuse(session) {
  await authRepository.revokeAllUserSessions(session.userId);
  logger.warn(
    { userId: String(session.userId), familyId: session.familyId },
    'Refresh token reuse detected; all sessions revoked',
  );
  return unauthorized(
    'This refresh token was already used. All sessions have been signed out.',
    'REFRESH_TOKEN_REUSED',
  );
}

/**
 * Rotate a refresh token. The next session is inserted first and only then is
 * the old one claimed (atomically). If the claim fails, because a parallel
 * refresh won or the family was revoked in between, the new row is deleted, so
 * a revoked family can never gain a live token.
 */
async function refresh({ refreshToken }, { ip, userAgent } = {}) {
  const tokenHash = hashToken(refreshToken);
  const current = await authRepository.findSessionByTokenHash(tokenHash);
  if (!current) throw invalidRefreshToken();
  if (current.replacedBy) throw await handleReuse(current);
  if (current.revokedAt || current.expiresAt <= new Date()) throw invalidRefreshToken();

  const user = await usersRepository.findById(current.userId);
  if (!user) throw invalidRefreshToken();

  const tokens = await issueTokens(user, { familyId: current.familyId, ip, userAgent });
  const nextHash = hashToken(tokens.refreshToken);
  const claimed = await authRepository.claimSessionForRotation({ tokenHash, replacedBy: nextHash });
  if (!claimed) {
    await authRepository.deleteSessionByTokenHash(nextHash);
    const latest = await authRepository.findSessionByTokenHash(tokenHash);
    if (latest?.replacedBy) throw await handleReuse(latest);
    throw invalidRefreshToken();
  }
  return tokens;
}

/** Sign out this device. Unknown or already revoked tokens are fine (idempotent). */
async function logout({ refreshToken }) {
  const session = await authRepository.findSessionByTokenHash(hashToken(refreshToken));
  if (session) await authRepository.revokeSessionFamily(session.familyId);
}

module.exports = { authService: { register, verifyEmail, login, refresh, logout } };
