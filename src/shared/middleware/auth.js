const asyncHandler = require('../http/asyncHandler');
const { unauthorized, forbidden } = require('../errors');
const { authService } = require('../../modules/auth/auth.service');

/** Requires "Authorization: Bearer <access token>"; sets req.user. */
const requireAuth = asyncHandler(async (req, res, next) => {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();
  req.user = await authService.authenticate(token);
  next();
});

/**
 * Allow the request only if the user has at least one of the given roles.
 * Use after requireAuth:  router.post('/x', requireAuth, requireRole('admin'), handler)
 * Controllers never check roles themselves.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!req.user.roles.some((role) => roles.includes(role))) return next(forbidden());
    return next();
  };
}

module.exports = { requireAuth, requireRole };
