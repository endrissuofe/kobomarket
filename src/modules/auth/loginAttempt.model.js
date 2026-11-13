const { Schema, model } = require('mongoose');

const LOGIN_WINDOW_SECONDS = 15 * 60;

// Login attempts per email + IP inside a 15-minute window. A successful login
// deletes the document.
const loginAttemptSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    count: { type: Number, required: true, default: 0 },
    windowStart: { type: Date, required: true },
  },
  { collection: 'loginAttempts' },
);

// Housekeeping only; the service checks the window itself because the TTL
// monitor runs about once a minute.
loginAttemptSchema.index({ windowStart: 1 }, { expireAfterSeconds: LOGIN_WINDOW_SECONDS });

module.exports = { LoginAttempt: model('LoginAttempt', loginAttemptSchema), LOGIN_WINDOW_SECONDS };
