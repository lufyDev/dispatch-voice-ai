import mongoose from 'mongoose';

/**
 * Mongo stands in for the contractor's field-service management software. In
 * reality this would be ServiceTitan or Housecall Pro behind an HTTP API, which
 * matters for two reasons the schema has to respect:
 *
 *   - it is SLOW and it can fail. Every tool call is a network call during a
 *     live phone call, so latency and partial failure are the normal case.
 *   - it is NOT ours. We cannot transactionally wrap "check the slot" and "book
 *     the slot", which is precisely why idempotency lives in the write itself.
 */
export async function connectDb(uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/dispatch') {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    // A booking agent on a live call cannot wait 30 seconds to find out the
    // database is down. Fail fast and let the agent escalate to a human.
    serverSelectionTimeoutMS: 3000,
  });
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
