const asyncHandler = require('../../shared/http/asyncHandler');
const { notificationsService } = require('./notifications.service');

const ok = (res, data) => res.json({ success: true, data });

const notificationsController = {
  list: asyncHandler(async (req, res) =>
    ok(res, await notificationsService.list(req.user, req.query)),
  ),
  unreadCount: asyncHandler(async (req, res) =>
    ok(res, await notificationsService.unreadCount(req.user)),
  ),
  markRead: asyncHandler(async (req, res) =>
    ok(res, { notification: await notificationsService.markRead(req.user, req.params.id) }),
  ),
  markAllRead: asyncHandler(async (req, res) =>
    ok(res, await notificationsService.markAllRead(req.user)),
  ),
};

module.exports = { notificationsController };
