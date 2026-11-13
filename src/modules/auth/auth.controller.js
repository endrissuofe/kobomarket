const asyncHandler = require('../../shared/http/asyncHandler');
const { authService } = require('./auth.service');

// HTTP in, HTTP out. All logic is in auth.service.
const authController = {
  register: asyncHandler(async (req, res) => {
    const user = await authService.register(req.body);
    res.status(201).json({
      success: true,
      data: { user, message: 'Check your email for a verification token' },
    });
  }),

  verifyEmail: asyncHandler(async (req, res) => {
    const user = await authService.verifyEmail(req.body);
    res.json({ success: true, data: { user } });
  }),
};

module.exports = { authController };
