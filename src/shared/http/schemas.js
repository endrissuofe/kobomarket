const { z } = require('zod');

// Reusable Zod pieces for route params and queries.
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const idParams = z.object({ id: objectId });

/** ?limit=&cursor= for list endpoints. */
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional(),
});

module.exports = { objectId, idParams, pageQuery };
