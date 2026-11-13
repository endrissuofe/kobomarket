const mongoose = require('mongoose');
const config = require('../config');

// Fail fast: without a connection a query throws at once instead of queueing
// in memory until a request times out.
mongoose.set('bufferCommands', false);
mongoose.set('strictQuery', true);

/** Open the shared Mongoose connection. Safe to call more than once. */
async function connect(uri = config.mongoUri) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await mongoose.connect(uri, {
    // IPv4 only: on some machines localhost / ::1 is unreachable.
    family: 4,
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 10,
  });
  // Build the indexes models declare (unique email, TTLs, ...) before traffic.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  return mongoose.connection;
}

/** Cheap round-trip used by the readiness check. */
async function ping() {
  if (mongoose.connection.readyState !== 1) throw new Error('MongoDB not connected');
  await mongoose.connection.db.admin().ping();
}

async function close() {
  await mongoose.disconnect();
}

module.exports = { mongoose, connect, ping, close };
