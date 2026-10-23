import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { config } from '../config';

async function main(): Promise<void> {
  console.log(`Connecting to MongoDB at: ${config.mongoUri.replace(/:([^@]+)@/, ':****@')}`);
  
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
  console.log('✓ Connected to MongoDB');

  const db = mongoose.connection.db!;
  const usersCollection = db.collection('users');
  const strategiesCollection = db.collection('strategies');

  const email = 'demo@trader.in';
  const password = 'demo123';
  const passwordHash = await bcrypt.hash(password, 10);

  const existingUser = await usersCollection.findOne({ email });

  let userId: string;
  if (existingUser) {
    userId = String(existingUser._id || existingUser.id);
    await usersCollection.updateOne(
      { _id: existingUser._id },
      {
        $set: {
          email,
          name: existingUser.name || 'Demo Trader',
          passwordHash,
          role: 'admin',
          updatedAt: Date.now(),
        },
        $unset: {
          totpSecret: '',
          totpPending: '',
          totpEnabledAt: '',
        },
      }
    );
    console.log(`✓ Updated demo user "${email}" with password "${password}" and cleared 2FA/TOTP.`);
  } else {
    userId = uuid();
    const newUser = {
      _id: userId,
      id: userId,
      email,
      name: 'Demo Trader',
      passwordHash,
      role: 'admin',
      createdAt: Date.now(),
    };
    await usersCollection.insertOne(newUser);
    console.log(`✓ Created new demo user "${email}" with password "${password}".`);
  }

  // Check if strategies exist, if not seed default examples
  const stratCount = await strategiesCollection.countDocuments({ userId });
  if (stratCount === 0) {
    const strategies = [
      {
        _id: uuid(),
        id: uuid(),
        userId,
        name: 'NIFTY MA Crossover',
        type: 'MA_CROSSOVER',
        symbols: ['RELIANCE', 'TCS'],
        params: { fast: 9, slow: 21, stopLossPct: 1.5, takeProfitPct: 3 },
        quantity: 10,
        exitMode: 'static',
        direction: 'both',
        enabled: false,
        createdAt: Date.now(),
      },
      {
        _id: uuid(),
        id: uuid(),
        userId,
        name: 'Bank Momentum',
        type: 'MOMENTUM',
        symbols: ['HDFCBANK', 'ICICIBANK'],
        params: { rocPeriod: 10, rocThreshold: 2, stopLossPct: 1.5, takeProfitPct: 4 },
        quantity: 15,
        exitMode: 'static',
        direction: 'both',
        enabled: false,
        createdAt: Date.now(),
      },
      {
        _id: uuid(),
        id: uuid(),
        userId,
        name: 'NTB Breakout (trailing)',
        type: 'NTB_BREAKOUT',
        symbols: ['INFY', 'SBIN'],
        params: {},
        quantity: 10,
        exitMode: 'trailing',
        direction: 'both',
        enabled: false,
        createdAt: Date.now(),
      },
    ];
    await strategiesCollection.insertMany(strategies);
    console.log(`✓ Seeded ${strategies.length} sample strategies for demo user.`);
  }

  console.log('\n======================================');
  console.log('DEMO CREDENTIALS:');
  console.log(`Email:    ${email}`);
  console.log(`Password: ${password}`);
  console.log('======================================\n');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Failed to seed user in database:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
