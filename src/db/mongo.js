const mongoose = require('mongoose');
const config = require('../config');

// Fail fast: without a connection a query throws at once instead of queueing
// in memory until a request times out.
mongoose.set('bufferCommands', false);
mongoose.set('strictQuery', true);
// Models are compiled before the connection opens, so Mongoose must not try to
// create collections or indexes at compile time. connect() builds them instead.
mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);

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
  // createIndexes only adds missing indexes; it never drops one.
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
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
