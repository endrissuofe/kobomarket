const { User } = require('./user.model');

// The only code that queries the users collection.
const usersRepository = {
  create({ email, passwordHash, name }) {
    return User.create({ email, passwordHash, name });
  },

  findById(id) {
    return User.findById(id);
  },

  /** Includes passwordHash, for login only. */
  findByEmailWithPassword(email) {
    return User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  },

  findByEmail(email) {
    return User.findOne({ email: email.toLowerCase() });
  },

  setWalletStatus(id, walletStatus) {
    return User.updateOne({ _id: id }, { $set: { walletStatus } });
  },

  /** Sets emailVerifiedAt once; a second call leaves the first date alone. */
  markEmailVerified(id, at = new Date()) {
    return User.updateOne({ _id: id, emailVerifiedAt: null }, { $set: { emailVerifiedAt: at } });
  },

  setPasswordHash(id, passwordHash) {
    return User.updateOne({ _id: id }, { $set: { passwordHash } });
  },
};

module.exports = { usersRepository };
