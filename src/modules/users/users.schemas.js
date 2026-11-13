const { z } = require('zod');

// Only profile fields. Email changes would need re-verification and password
// changes go through forgot/reset; roles, status and walletStatus are never
// user-editable. .strict() turns any of those into a 422.
const updateMeBody = z.object({ name: z.string().trim().min(1).max(100) }).strict();

module.exports = { updateMeBody };
