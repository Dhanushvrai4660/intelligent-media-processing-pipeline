// Express 4 does not catch rejected promises from async route handlers -- an unhandled
// rejection in, say, getStatus() would otherwise crash the process instead of returning
// a clean 500. Wrapping every async controller keeps that failure mode contained.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
