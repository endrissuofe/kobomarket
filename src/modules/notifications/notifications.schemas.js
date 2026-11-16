const { z } = require('zod');
const { idParams, pageQuery } = require('../../shared/http/schemas');

const listQuery = pageQuery.extend({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

module.exports = { listQuery, idParams };
