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
        // Field problems by field name; problems with the object as a whole
        // (e.g. unknown keys under .strict()) under _form.
        const { fieldErrors, formErrors } = result.error.flatten();
        const details = formErrors.length ? { ...fieldErrors, _form: formErrors } : fieldErrors;
        return next(validationError(details));
      }
      // req.query is a getter in some Express versions; define it explicitly.
      Object.defineProperty(req, part, { value: result.data, writable: true, enumerable: true });
    }
    return next();
  };
};
