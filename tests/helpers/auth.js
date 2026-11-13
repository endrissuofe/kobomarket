// Auth test helpers. Each test registers its own user under a unique email,
// so tests never need to wipe collections.
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const mailer = require('../../src/integrations/email');

const PASSWORD = 'correct-horse-battery';

const uniqueEmail = (prefix = 'user') => `${prefix}-${randomUUID()}@test.kobomarket.dev`;

/** Pull the token out of the latest email sent to this address. */
function tokenFromEmail(email) {
  const message = mailer.lastMessageTo(email);
  if (!message) throw new Error(`No email sent to ${email}`);
  return message.text.split('\n')[1].trim();
}

async function register(app, { email = uniqueEmail(), password = PASSWORD, name } = {}) {
  const res = await request(app).post('/api/v1/auth/register').send({ email, password, name });
  return { res, email, password };
}

/** Register and verify; returns credentials ready for login. */
async function registerVerified(app, opts) {
  const { res, email, password } = await register(app, opts);
  if (res.status !== 201)
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  await request(app)
    .post('/api/v1/auth/verify-email')
    .send({ token: tokenFromEmail(email) });
  return { email, password, user: res.body.data.user };
}

/**
 * Register, verify and log in a fresh user. Pass roles to grant them directly
 * in Mongo first (tests only; real admins come from make-admin or the seed).
 */
async function signIn(app, { roles } = {}) {
  const creds = await registerVerified(app);
  if (roles) {
    const { User } = require('../../src/modules/users/user.model');
    await User.updateOne({ _id: creds.user.id }, { $set: { roles } });
  }
  const res = await request(app).post('/api/v1/auth/login').send(creds);
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const { accessToken, refreshToken } = res.body.data;
  return {
    ...creds,
    userId: creds.user.id,
    accessToken,
    refreshToken,
    auth: { Authorization: `Bearer ${accessToken}` },
  };
}

module.exports = { PASSWORD, uniqueEmail, tokenFromEmail, register, registerVerified, signIn };
