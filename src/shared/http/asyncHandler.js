// Express 4 does not catch rejected promises. Wrap async handlers so a thrown
// AppError reaches the error middleware.
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};
