/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
import { config } from '../config';

/**
 * Helper for Zerodha's daily access-token flow (the token expires every day).
 *
 *   Step 1:  npm run kite:login
 *            → prints the login URL. Open it, log in, approve.
 *            → you land on your redirect URL containing `?request_token=XXXX`.
 *
 *   Step 2:  npm run kite:login -- XXXX
 *            → prints today's ACCESS TOKEN. Paste it into .env as
 *              ZERODHA_ACCESS_TOKEN, then start the server with DATA_SOURCE=zerodha.
 */
async function main() {
  let KiteConnect: any;
  try {
    KiteConnect = require('kiteconnect').KiteConnect;
  } catch {
    console.error('kiteconnect SDK not installed. Run: npm install kiteconnect');
    process.exit(1);
  }

  if (!config.zerodha.apiKey || !config.zerodha.apiSecret) {
    console.error('Set ZERODHA_API_KEY and ZERODHA_API_SECRET in .env first.');
    process.exit(1);
  }

  const kc = new KiteConnect({ api_key: config.zerodha.apiKey });
  const requestToken = process.argv[2];

  if (!requestToken) {
    console.log('\n1) Open this URL, log in, and approve:\n');
    console.log('   ' + kc.getLoginURL());
    console.log('\n2) Copy the `request_token` from the redirect URL, then run:\n');
    console.log('   npm run kite:login -- <request_token>\n');
    return;
  }

  try {
    const session = await kc.generateSession(requestToken, config.zerodha.apiSecret);
    console.log('\n✅ Access token (valid for today):\n');
    console.log('   ' + session.access_token);
    console.log('\nPaste it into .env:  ZERODHA_ACCESS_TOKEN=' + session.access_token + '\n');
  } catch (e) {
    console.error('Failed to generate session:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

main();
