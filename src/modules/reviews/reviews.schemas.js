const { z } = require('zod');

const createBody = z
  .object({
    rating: z.number().int('Rating is a whole number of stars').min(1).max(5),
    comment: z.string().trim().max(2000).optional(),
  })
  .strict();

module.exports = { createBody };
