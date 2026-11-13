const crypto = require('node:crypto');

// Paystack signs the raw request body with HMAC-SHA512 using the secret key
// and sends the hex digest in x-paystack-signature.

function sign(rawBody, secret) {
  return crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
}

/** Constant-time check. False for a missing, malformed or wrong signature. */
function isValidSignature(rawBody, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature)) {
    return false;
  }
  const expected = Buffer.from(sign(rawBody, secret), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

module.exports = { sign, isValidSignature };
