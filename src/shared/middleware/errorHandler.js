const { AppError } = require('../errors');
const { logger } = require('../logger');

// Postgres error codes we can explain to the client.
const PG_CODES = {
  23505: { status: 409, code: 'DUPLICATE', message: 'This record already exists' },
  23514: { status: 422, code: 'CONSTRAINT_VIOLATION', message: 'The request breaks a data rule' },
  23503: {
    status: 422,
    code: 'REFERENCE_NOT_FOUND',
    message: 'A referenced record does not exist',
  },
};

function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
  });
}

function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  const pg = PG_CODES[err.code];
  if (pg) {
    return res.status(pg.status).json({
      success: false,
      error: { code: pg.code, message: pg.message, details: { constraint: err.constraint } },
    });
  }

  logger.error({ err }, 'Unhandled error');
  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong',
      details: { requestId: req.id },
    },
  });
}

module.exports = { notFoundHandler, errorHandler };
