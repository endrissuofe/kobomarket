// Connect the shared Mongoose connection for one test file.
// Usage: const mongo = useMongo();  (registers beforeAll/afterAll hooks)
const mongo = require('../../src/db/mongo');

function useMongo() {
  beforeAll(() => mongo.connect());
  afterAll(() => mongo.close());
  return mongo;
}

module.exports = { useMongo };
