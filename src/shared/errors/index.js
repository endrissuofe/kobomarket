// Typed errors. Services throw these; the error middleware turns them into
// { success: false, error: { code, message, details } }.
class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const badRequest = (message, details) => new AppError('BAD_REQUEST', message, 400, details);
const validationError = (details) =>
  new AppError('VALIDATION_ERROR', 'Invalid request', 422, details);
const unauthorized = (message = 'Authentication required') =>
  new AppError('UNAUTHORIZED', message, 401);
const forbidden = (message = 'You do not have access to this resource') =>
  new AppError('FORBIDDEN', message, 403);
const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`, 404);
const conflict = (code, message, details) => new AppError(code, message, 409, details);

module.exports = {
  AppError,
  badRequest,
  validationError,
  unauthorized,
  forbidden,
  notFound,
  conflict,
};
