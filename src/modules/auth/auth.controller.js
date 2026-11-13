const asyncHandler = require('../../shared/http/asyncHandler');
const { authService } = require('./auth.service');

const clientInfo = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

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

  login: asyncHandler(async (req, res) => {
    const result = await authService.login(req.body, clientInfo(req));
    res.json({ success: true, data: result });
  }),

  refresh: asyncHandler(async (req, res) => {
    const tokens = await authService.refresh(req.body, clientInfo(req));
    res.json({ success: true, data: tokens });
  }),

  logout: asyncHandler(async (req, res) => {
    await authService.logout(req.body);
    res.status(204).end();
  }),

  forgotPassword: asyncHandler(async (req, res) => {
    await authService.forgotPassword(req.body);
    res.json({
      success: true,
      data: { message: 'If an account exists for that email, a reset token has been sent' },
    });
  }),

  resetPassword: asyncHandler(async (req, res) => {
    await authService.resetPassword(req.body);
    res.json({ success: true, data: { message: 'Password updated. Please log in again.' } });
  }),
};

module.exports = { authController };
