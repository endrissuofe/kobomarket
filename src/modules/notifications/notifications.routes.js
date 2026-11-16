const { Router } = require('express');
const validate = require('../../shared/middleware/validate');
const { requireAuth } = require('../../shared/middleware/auth');
const { notificationsController } = require('./notifications.controller');
const schemas = require('./notifications.schemas');

// Mounted at /api/v1/notifications. Every user sees only their own.
const router = Router();
router.use(requireAuth);

router.get('/', validate({ query: schemas.listQuery }), notificationsController.list);
router.get('/unread-count', notificationsController.unreadCount);
// Before /:id/read so "read-all" is not read as an id.
router.patch('/read-all', notificationsController.markAllRead);
router.patch('/:id/read', validate({ params: schemas.idParams }), notificationsController.markRead);

module.exports = router;
