const { Schema, model } = require('mongoose');

const VENDOR_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

const bankSchema = new Schema(
  {
    bankCode: { type: String, required: true, trim: true },
    accountNumber: { type: String, required: true, trim: true },
    accountName: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const vendorSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    storeName: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, unique: true },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    bank: { type: bankSchema, required: true },
    status: {
      type: String,
      enum: Object.values(VENDOR_STATUS),
      default: VENDOR_STATUS.PENDING,
    },
    rejectionReason: { type: String, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'vendors' },
);

// Admin queue: by status, oldest first, with _id as the cursor tie-break.
vendorSchema.index({ status: 1, _id: 1 });

module.exports = { Vendor: model('Vendor', vendorSchema), VENDOR_STATUS };
