const { Compensation } = require('./compensation.model');

// The only code that queries the compensations collection.
const compensationsRepository = {
  record({ type, payload, reason, error }) {
    return Compensation.create({ type, payload, reason, lastError: error ?? null });
  },
};

module.exports = { compensationsRepository };
