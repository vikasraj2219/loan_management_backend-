/**
 * Wraps an async route handler and forwards any rejected promise
 * to Express's error-handling middleware via next(err).
 */
const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = catchAsync;
