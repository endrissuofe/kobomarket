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

// Login does not re-check password rules: old passwords may predate them.
const loginBody = z.object({ email, password: z.string().min(1).max(128) });

const refreshBody = z.object({ refreshToken: token });

const forgotPasswordBody = z.object({ email });

const resetPasswordBody = z.object({ token, password });

module.exports = {
  registerBody,
  verifyEmailBody,
  loginBody,
  refreshBody,
  forgotPasswordBody,
  resetPasswordBody,
};
