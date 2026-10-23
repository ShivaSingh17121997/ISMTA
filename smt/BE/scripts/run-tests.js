/**
 * Run every backend test suite, even after one fails, against a TEST database.
 *
 *   npm test
 *
 * Replaces a single `a && b && c …` chain, which stopped at the first failing
 * suite and hid every result after it, and which let the persistence suite
 * write to the live `smt_trading` database. Here MONGO_URI points at
 * `smt_trading_test` unless it is already set to a database whose name ends in
 * `_test`; a non-test URI is refused rather than written to.
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'mongodb://127.0.0.1:27017/smt_trading_test';

const uri = process.env.MONGO_URI;
if (uri && !/_test(\?|$)/.test(uri.split('/').pop() ?? '')) {
  console.error(`Refusing to run tests against MONGO_URI=${uri}: the database name must end in _test.`);
  process.exit(2);
}
const env = { ...process.env, MONGO_URI: uri || TEST_DB };

// The suite order, from package.json's "testSuites"; any *.test.ts not listed
// still runs, after them, so a new file is never silently skipped.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const listed = pkg.testSuites ?? [];
const onDisk = fs.readdirSync(path.join(ROOT, 'src', 'tests')).filter((f) => f.endsWith('.test.ts')).map((f) => f.replace(/\.test\.ts$/, ''));
const suites = [...listed, ...onDisk.filter((s) => !listed.includes(s)).sort()];

const tsNode = path.join(ROOT, 'node_modules', 'ts-node', 'dist', 'bin.js');
const failed = [];
const started = Date.now();
for (const s of suites) {
  const r = spawnSync(process.execPath, [tsNode, '--transpile-only', path.join('src', 'tests', `${s}.test.ts`)], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
  if (r.status !== 0) failed.push(s);
}

const secs = ((Date.now() - started) / 1000).toFixed(0);
if (failed.length) {
  console.error(`\n✗ ${failed.length} of ${suites.length} suites failed (${secs}s): ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\n✓ all ${suites.length} suites passed (${secs}s)`);
