const { z } = require('zod');

const email = z.string().trim().toLowerCase().email().max(254);
// Upper bound stops someone sending a megabyte "password" to burn CPU in argon2.
const password = z.string().min(8, 'Password must be at least 8 characters').max(128);
const token = z.string().trim().min(10).max(200);

const registerBody = z.object({
  email,
  password,
  name: z.string().trim().min(1).max(100).optional(),
});

const verifyEmailBody = z.object({ token });

module.exports = { registerBody, verifyEmailBody };
