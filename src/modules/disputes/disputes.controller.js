const asyncHandler = require('../../shared/http/asyncHandler');
const { disputesService } = require('./disputes.service');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const disputesController = {
  open: asyncHandler(async (req, res) =>
    ok(res, { dispute: await disputesService.open(req.user, req.params.id, req.body) }, 201),
  ),
  respond: asyncHandler(async (req, res) =>
    ok(res, { dispute: await disputesService.respond(req.user, req.params.id, req.body) }),
  ),
  resolve: asyncHandler(async (req, res) =>
    ok(res, { dispute: await disputesService.resolve(req.user, req.params.id, req.body) }),
  ),
  listAll: asyncHandler(async (req, res) => ok(res, await disputesService.listAll(req.query))),
  listMine: asyncHandler(async (req, res) =>
    ok(res, await disputesService.listMine(req.user, req.query)),
  ),
  get: asyncHandler(async (req, res) =>
    ok(res, { dispute: await disputesService.get(req.params.id) }),
  ),
};

module.exports = { disputesController };
