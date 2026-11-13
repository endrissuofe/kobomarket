const { Schema, model } = require('mongoose');

const TOKEN_TYPES = Object.freeze({ EMAIL: 'EMAIL', RESET: 'RESET' });

// Only the SHA-256 of the token is stored; the raw token goes out by email.
const verificationTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: Object.values(TOKEN_TYPES), required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'verificationTokens' },
);

verificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = {
  VerificationToken: model('VerificationToken', verificationTokenSchema),
  TOKEN_TYPES,
};
