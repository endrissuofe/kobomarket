const { AsyncLocalStorage } = require('node:async_hooks');
const pino = require('pino');
const config = require('../config');

// Holds the request ID for the current request, so every log line carries it,
// even lines written deep inside services and repositories.
const requestContext = new AsyncLocalStorage();

const logger = pino({
  level: config.isTest ? 'silent' : config.logLevel,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.refreshToken',
      '*.accountNumber',
    ],
    censor: '[redacted]',
  },
  mixin() {
    const store = requestContext.getStore();
    return store ? { requestId: store.requestId } : {};
  },
});

module.exports = { logger, requestContext };
