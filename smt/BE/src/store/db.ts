import mongoose from 'mongoose';
import { config } from '../config';
import { logger } from '../utils/logger';

let connected = false;

/** True once a live MongoDB connection is established (and while it stays up). */
export function isMongoConnected(): boolean {
  return connected;
}

/**
 * Connect to MongoDB (the same server you open in MongoDB Compass).
 *
 * Non-fatal by design: if the DB is unreachable the app keeps running on the
 * in-memory cache only — data simply won't persist across restarts. This mirrors
 * the project's "works in sim mode even without the broker SDK" philosophy.
 */
export async function connectMongo(): Promise<boolean> {
  const uri = config.mongoUri;
  if (!uri) {
    logger.warn('MONGO_URI not set — running with in-memory store only (no persistence)');
    return false;
  }

  // strictQuery:true silently STRIPS any filter field that is not in the schema.
  // Every schema here is `{ _id }` with strict:false, so under strictQuery:true a
  // filter like `{ userId }` became `{}` — match-all — and a targeted delete
  // wiped whole collections. That has happened once. false = the filter you
  // wrote is the filter that runs.
  mongoose.set('strictQuery', false);
  // Don't queue ops while disconnected; we gate every write on isMongoConnected().
  mongoose.set('bufferCommands', false);

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    logger.info(`MongoDB connected → ${redact(uri)}`);

    mongoose.connection.on('disconnected', () => {
      connected = false;
      logger.warn('MongoDB disconnected — falling back to in-memory store');
    });
    mongoose.connection.on('reconnected', () => {
      connected = true;
      logger.info('MongoDB reconnected');
    });
    return true;
  } catch (e) {
    connected = false;
    logger.error(
      `MongoDB connection failed (${e instanceof Error ? e.message : e}) — using in-memory store only`,
    );
    logger.error('Start MongoDB locally, or set MONGO_URI in .env to your Compass connection string.');
    return false;
  }
}

/** Hide credentials before logging the connection string. */
function redact(uri: string): string {
  return uri.replace(/\/\/([^:/]+):([^@]+)@/, '//$1:****@');
}
