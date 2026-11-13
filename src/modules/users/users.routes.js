const { Router } = require('express');
const { requireAuth } = require('../../shared/middleware/auth');
const { usersController } = require('./users.controller');

const router = Router();

router.get('/me', requireAuth, usersController.getMe);

module.exports = router;
