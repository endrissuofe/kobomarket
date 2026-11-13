const { validationError } = require('../errors');

/**
 * Validate and replace req.body / req.query / req.params with the parsed
 * (trimmed, coerced, stripped) values from the given Zod schemas.
 *   router.post('/x', validate({ body: schema }), handler)
 */
module.exports = function validate(schemas) {
  return (req, res, next) => {
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (!result.success) {
        return next(validationError(result.error.flatten().fieldErrors));
      }
      // req.query is a getter in some Express versions; define it explicitly.
      Object.defineProperty(req, part, { value: result.data, writable: true, enumerable: true });
    }
    return next();
  };
};
