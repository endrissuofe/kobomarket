const asyncHandler = require('../../shared/http/asyncHandler');
const { usersService } = require('./users.service');

const usersController = {
  getMe: asyncHandler(async (req, res) => {
    const user = await usersService.getById(req.user.id);
    res.json({ success: true, data: { user } });
  }),
};

module.exports = { usersController };
