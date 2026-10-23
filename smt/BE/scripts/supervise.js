/**
 * Keep the backend running: start it, and restart it if it exits for any
 * reason other than a deliberate stop.
 *
 *   npm run build && npm run start:supervised
 *
 * Restarts back off from 1s to 60s so a crash loop does not hammer Yahoo or the
 * broker, and the backoff resets once a run has stayed up 10 minutes. Ctrl+C
 * (or SIGTERM) stops the child cleanly and then the supervisor. No dependencies.
 *
 * Use this instead of `npm run dev` for anything real: ts-node-dev restarts on
 * every file save, which is exactly the crash-between-fill-and-save window the
 * boot fill audit exists to catch.
 */
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', 'dist', 'server.js');
const MIN_MS = 1_000;
const MAX_MS = 60_000;
const STABLE_MS = 10 * 60_000;

let child = null;
let stopping = false;
let delay = MIN_MS;

function log(msg) {
  console.log(`[supervise ${new Date().toISOString()}] ${msg}`);
}

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [ENTRY], { stdio: 'inherit', env: process.env });
  log(`started backend (pid ${child.pid})`);
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) {
      log('backend stopped; supervisor exiting');
      process.exit(0);
    }
    if (Date.now() - startedAt > STABLE_MS) delay = MIN_MS;
    log(`backend exited (code ${code}, signal ${signal}); restarting in ${delay / 1000}s`);
    setTimeout(start, delay);
    delay = Math.min(MAX_MS, delay * 2);
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (!child) process.exit(0);
  // On Windows, child.kill() is TerminateProcess: the backend would die before
  // it saves its queued writes. Ctrl+C already reaches it through the shared
  // console, so just wait for it to finish shutting down. Elsewhere, SIGTERM
  // runs its graceful shutdown.
  if (process.platform !== 'win32') child.kill('SIGTERM');
  // The backend flushes its writes within ~4s; force it after 10s.
  setTimeout(() => child && child.kill('SIGKILL'), 10_000).unref();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
start();
