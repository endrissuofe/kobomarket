const { randomUUID } = require('node:crypto');
const { requestContext } = require('../logger');

// Use the caller's X-Request-Id if given, otherwise create one.
module.exports = function requestId(req, res, next) {
  const id = req.get('x-request-id') || randomUUID();
  req.id = id;
  res.set('x-request-id', id);
  requestContext.run({ requestId: id }, next);
};
