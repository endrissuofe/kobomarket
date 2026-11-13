const { Schema, model } = require('mongoose');

// One document per refresh token. A login starts a family (familyId); each
// rotation adds a new document to the family and points the old one at it via
// replacedBy. Presenting a token whose replacedBy is set is reuse.
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    replacedBy: { type: String, default: null },
    revokedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    ip: String,
    userAgent: String,
  },
  { timestamps: true, collection: 'sessions' },
);

// Mongo deletes the document once it has expired.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = { Session: model('Session', sessionSchema) };
