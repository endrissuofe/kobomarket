const { z } = require('zod');

const bank = z.object({
  // Nigerian bank codes as Paystack lists them, e.g. "058" or "50211".
  bankCode: z
    .string()
    .trim()
    .regex(/^\d{3,6}$/, 'Bank code must be 3 to 6 digits'),
  // NUBAN account numbers are 10 digits.
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Account number must be 10 digits'),
  accountName: z.string().trim().min(2).max(100),
});

const applyBody = z.object({
  storeName: z.string().trim().min(2).max(80),
  description: z.string().trim().max(2000).optional(),
  bank,
});

module.exports = { applyBody };
