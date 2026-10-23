/**
 * Turns two-factor off for one account, for when its secret can no longer be
 * read (BROKER_CREDENTIALS_KEY lost or changed). The user enrols again in
 * Settings afterwards. Stop the backend first: it holds users in memory and
 * would write the old value back.
 *
 *   npm run totp:reset -- someone@example.com
 *
 * Writes by `_id` only.
 */
import mongoose from 'mongoose';
import { config } from '../config';

async function main(): Promise<void> {
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  if (!email) {
    console.error('usage: npm run totp:reset -- <email>');
    process.exit(2);
  }
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
  const users = mongoose.connection.db!.collection('users');
  const matches = (await users.find({}, { projection: { _id: 1, email: 1, totpSecret: 1, totpPending: 1 } }).toArray())
    .filter((u) => String(u.email ?? '').trim().toLowerCase() === email);
  if (matches.length !== 1) {
    console.error(matches.length ? `${matches.length} accounts match ${email}; fix that by hand` : `no account for ${email}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const u = matches[0];
  if (!u.totpSecret && !u.totpPending) {
    console.log(`${email}: two-factor is already off`);
  } else {
    const r = await users.updateOne({ _id: u._id }, { $unset: { totpSecret: '', totpPending: '', totpEnabledAt: '' } });
    console.log(`${email}: two-factor turned off (matched ${r.matchedCount}). Enrol again in Settings.`);
  }
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
