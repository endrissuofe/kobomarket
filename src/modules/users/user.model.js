const { Schema, model } = require('mongoose');

const ROLES = Object.freeze({ BUYER: 'buyer', VENDOR: 'vendor', ADMIN: 'admin' });
const USER_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', FROZEN: 'FROZEN' });
// The wallet lives in Postgres. Mongo only knows whether it has been opened yet,
// never its balance.
const WALLET_STATUS = Object.freeze({ PENDING: 'PENDING', READY: 'READY' });

const userSchema = new Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, trim: true, maxlength: 100 },
    roles: {
      type: [{ type: String, enum: Object.values(ROLES) }],
      default: [ROLES.BUYER],
    },
    emailVerifiedAt: { type: Date, default: null },
    status: { type: String, enum: Object.values(USER_STATUS), default: USER_STATUS.ACTIVE },
    walletStatus: {
      type: String,
      enum: Object.values(WALLET_STATUS),
      default: WALLET_STATUS.PENDING,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'users',
    toJSON: {
      transform(doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        return ret;
      },
    },
  },
);

const User = model('User', userSchema);

module.exports = { User, ROLES, USER_STATUS, WALLET_STATUS };
