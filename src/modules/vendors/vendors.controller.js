const asyncHandler = require('../../shared/http/asyncHandler');
const { vendorsService } = require('./vendors.service');

const vendorsController = {
  apply: asyncHandler(async (req, res) => {
    const vendor = await vendorsService.apply(req.user, req.body);
    res.status(201).json({ success: true, data: { vendor } });
  }),

  getMine: asyncHandler(async (req, res) => {
    const vendor = await vendorsService.getMine(req.user.id);
    res.json({ success: true, data: { vendor } });
  }),

  getPublic: asyncHandler(async (req, res) => {
    const vendor = await vendorsService.getPublic(req.params.id);
    res.json({ success: true, data: { vendor } });
  }),
};

module.exports = { vendorsController };
