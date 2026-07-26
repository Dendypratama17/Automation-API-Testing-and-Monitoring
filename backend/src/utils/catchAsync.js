/**
 * Wraps an async Express route handler so thrown errors / rejected promises
 * are forwarded to next(err) instead of crashing the whole Node process.
 */
function catchAsync(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = catchAsync;
