/**
 * One-shot Groww credential and mapping check. `npm run groww:verify`
 *
 * The Groww adapter was written from published documentation without an
 * account to test against, so every request shape in it is unconfirmed. This
 * script is the bridge between "should work" and "does work": it authenticates,
 * reads the balance and the holdings, and prints them so they can be compared
 * against the Groww app on your phone.
 *
 * It places NO orders and moves no money. Run it before setting BROKER=groww.
 */
import 'dotenv/config';
import { GrowwBroker } from '../brokers/GrowwBroker';
import { config } from '../config';

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  if (!config.groww.apiKey || !config.groww.totpSecret) {
    console.error('Set GROWW_API_KEY and GROWW_TOTP_SECRET in .env first.');
    process.exit(1);
  }

  const g = new GrowwBroker();
  console.log('Authenticating with Groww (API key + TOTP)…');
  const funds = await g.verifyCredentials();

  console.log('\n── FUNDS ──');
  console.log(`  cash        ${inr(funds.cash)}`);
  console.log(`  used margin ${inr(funds.usedMargin)}`);
  console.log(`  unsettled   ${inr(funds.unsettled)}`);

  if (funds.cash === 0) {
    console.log('\n  ⚠ Cash read as ZERO. Either the account is empty, or the field names in');
    console.log('    mapFunds() do not match what your account returns. The raw payload is');
    console.log('    printed below — check it before trusting this number.');
  }

  const holdings = await g.getHoldings();
  console.log('\n── HOLDINGS ──');
  if (!holdings?.length) console.log('  none reported');
  else for (const h of holdings) console.log(`  ${h.symbol.padEnd(14)} ${String(h.quantity).padStart(6)} @ ${inr(h.averagePrice)}`);

  console.log('\n── RAW FUNDS PAYLOAD ──');
  console.log(JSON.stringify(funds.raw, null, 2).slice(0, 4000));

  console.log('\nNow compare the cash figure above with the Groww app.');
  console.log('If they match, the adapter is reading your real balance and you can set BROKER=groww.');
  console.log('If they do not, fix the field names in mapFunds() before trading.');
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : e}`);
  console.error('\nCommon causes: wrong TOTP secret, API subscription inactive, or the');
  console.error('server IP not whitelisted in Groww API settings.');
  process.exit(1);
});
