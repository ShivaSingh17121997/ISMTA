'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { brokerApi } from '../lib/api';
import { inr } from '../lib/format';
import type { BrokerConnectionView, BrokerPlan, BrokerTestResult } from '../lib/types';
import { formatDuration, istDateTime, useNow } from '../lib/useNow';
import { useAuth } from '../providers/AuthProvider';
import { useSystem } from '../providers/SystemProvider';
import { useToast } from '../providers/ToastProvider';
import { Badge, Card, ToggleSwitch } from './ui';

const INPUT =
  'mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';
const BTN =
  'rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900';
const BTN_PRIMARY =
  'rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60';
const BTN_DANGER =
  'rounded-lg border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40';

const STATUS: Record<BrokerConnectionView['status'], { label: string; tone: 'neutral' | 'green' | 'amber' | 'red' }> = {
  not_connected: { label: 'Not connected', tone: 'neutral' },
  connected: { label: 'Connected', tone: 'green' },
  expired: { label: 'Session ended', tone: 'amber' },
  error: { label: 'Error', tone: 'red' },
};

const PLAN_COPY: Record<BrokerPlan, string> = {
  personal:
    'Orders, holdings, positions and funds go through your Kite app. Prices stay on Yahoo: the free plan has no live quotes, price stream or historical candles.',
  connect:
    'Everything in Free, plus live prices streamed from Kite. The first connected paid key feeds prices for the whole terminal, and Yahoo covers anything Kite does not. Subscribe on developers.kite.trade first — a free key set to Paid is refused and prices stay on Yahoo.',
};

function Notice({ tone, children }: { tone: 'amber' | 'red' | 'blue'; children: ReactNode }) {
  const cls = {
    amber: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
    red: 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
    blue: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200',
  }[tone];
  return <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${cls}`}>{children}</div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => {},
        );
      }}
      className="text-xs text-blue-600 hover:underline dark:text-blue-400"
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * The user's own Zerodha account, through their own Kite Connect app.
 *
 * Four independent controls, in the order a person sets them up: the plan
 * (free Personal or paid Connect), the keys, the daily connection, and the
 * paper/live switch. All four are always visible so the whole path can be
 * seen on day one; each stays disabled until the step before it is done.
 * Connecting never trades by itself; live is its own password-confirmed step,
 * and the server lists what blocks it.
 *
 * Reads `?broker=connected|error&reason=` — where Kite's redirect lands — so it
 * must render inside a Suspense boundary.
 */
export function BrokerConnectionCard() {
  const { user } = useAuth();
  const { push } = useToast();
  const { refresh: refreshSystem } = useSystem();
  const router = useRouter();
  const params = useSearchParams();
  const now = useNow(30_000);

  const [conn, setConn] = useState<BrokerConnectionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [draftPlan, setDraftPlan] = useState<BrokerPlan>('personal');
  const [editingKeys, setEditingKeys] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');

  const [test, setTest] = useState<{ result: BrokerTestResult; publicIp: string | null } | null>(null);

  const [confirmLive, setConfirmLive] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await brokerApi.zerodha();
      setConn(r.connection);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the Zerodha connection');
    }
  }, []);

  useEffect(() => {
    // Both reads start in timer callbacks: `react-hooks/set-state-in-effect`
    // forbids a state update reachable synchronously from the effect body.
    const first = setTimeout(() => void load(), 0);
    const id = setInterval(() => void load(), 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load]);

  // Kite's redirect comes back here: announce the outcome once, then clean the URL.
  const outcome = params.get('broker');
  const reason = params.get('reason');
  const announced = useRef(false);
  useEffect(() => {
    if (!outcome || announced.current) return;
    announced.current = true;
    if (outcome === 'connected') push('info', 'Zerodha connected. Kite ends the session at 06:00 IST, so connect again each trading day.');
    else push('critical', `Zerodha login failed: ${reason ?? 'no reason given'}`);
    refreshSystem();
    router.replace('/settings');
  }, [outcome, reason, push, refreshSystem, router]);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const paperBlocked = (conn?.liveBlockers ?? []).some((b) => /paper books hold simulated lots|simulated LIQUIDCASE/.test(b));

  const clearPaper = () => {
    if (
      !window.confirm(
        'Clear all paper lots and paper cash-sweep units?\n\n' +
          'They are closed at today\'s price on paper only: no order is sent to Zerodha, and your real account is not touched. ' +
          'This cannot be undone, but the lots stay in their history marked as cleared.',
      )
    ) {
      return;
    }
    void run('clear', async () => {
      const r = await brokerApi.clearPaper();
      const lots = r.books.reduce((s, b) => s + b.lots, 0);
      push(
        'info',
        `Cleared ${lots} paper lot(s)` +
          (r.books.length ? ` in ${r.books.map((b) => b.symbol).join(', ')}` : '') +
          (r.sweep ? ` and ${r.sweep.units} paper sweep unit(s)` : '') +
          '. Nothing was sent to Zerodha.',
      );
      await load();
      refreshSystem();
    });
  };

  if (!conn) {
    return (
      <Card title="Zerodha (Kite Connect)">
        <p className="text-sm text-zinc-500">{loadError ?? 'Loading…'}</p>
      </Card>
    );
  }

  const plan = conn.configured ? conn.plan : draftPlan;
  const paid = plan === 'connect';
  const live = conn.tradingMode === 'live';
  const connected = conn.status === 'connected';
  const status = STATUS[conn.status];
  const keyOk = conn.configured && conn.credentialsKey.configured && conn.credentialsKey.matches;

  const togglePlan = () => {
    const next: BrokerPlan = paid ? 'personal' : 'connect';
    if (!conn.configured) {
      setDraftPlan(next);
      return;
    }
    void run('plan', async () => {
      const r = await brokerApi.setPlan(next);
      setConn(r.connection);
      setTest(null);
      push('info', next === 'connect' ? 'Plan set to Paid: live prices will stream from Kite once connected.' : 'Plan set to Free: prices come from Yahoo.');
    });
  };

  const saveKeys = (e: FormEvent) => {
    e.preventDefault();
    void run('keys', async () => {
      const r = await brokerApi.saveCredentials({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), plan });
      setConn(r.connection);
      setApiKey('');
      setApiSecret('');
      setEditingKeys(false);
      setTest(null);
      push('info', 'Keys saved and encrypted. Now connect Zerodha.');
    });
  };

  const removeKeys = () => {
    if (!window.confirm('Remove your Zerodha keys from this server? You can add them again later.')) return;
    void run('remove', async () => {
      const r = await brokerApi.remove();
      setConn(r.connection);
      setTest(null);
      refreshSystem();
    });
  };

  const connect = () =>
    void run('login', async () => {
      const { url } = await brokerApi.loginUrl();
      window.location.assign(url);
    });

  const runTest = () =>
    void run('test', async () => {
      const r = await brokerApi.test();
      setConn(r.connection);
      setTest({ result: r.result, publicIp: r.publicIp });
    });

  const disconnect = () => {
    const warn = live
      ? 'Disconnect while live? Every order to Zerodha will be refused until you connect again.'
      : 'Disconnect from Zerodha?';
    if (!window.confirm(warn)) return;
    void run('disconnect', async () => {
      const r = await brokerApi.disconnect();
      setConn(r.connection);
      setTest(null);
      refreshSystem();
    });
  };

  const goLive = (e: FormEvent) => {
    e.preventDefault();
    void run('mode', async () => {
      const r = await brokerApi.setMode({ mode: 'live', password, code: code.replace(/\s+/g, '') || undefined });
      setConn(r.connection);
      setConfirmLive(false);
      setPassword('');
      setCode('');
      setAcknowledged(false);
      refreshSystem();
      push('critical', 'Live trading is ON. Orders now go to your Zerodha account with real money.');
    });
  };

  const goPaper = () => {
    if (!window.confirm('Switch to paper trading? New orders will be simulated. Books holding shares bought live will pause.')) return;
    void run('mode', async () => {
      const r = await brokerApi.setMode({ mode: 'paper' });
      setConn(r.connection);
      refreshSystem();
      push(
        'warn',
        r.pausedBooks.length
          ? `Paper trading. Paused because they hold real shares: ${r.pausedBooks.join(', ')}.`
          : 'Paper trading. Orders are simulated.',
      );
    });
  };

  // With no keys saved the server has nothing to check yet; say what comes first.
  const blockers = conn.configured
    ? conn.liveBlockers
    : ['Save your Kite API key and secret above.', 'Connect Zerodha.'];

  const md = conn.marketData;
  const feedLine = (() => {
    if (md.feed !== 'yahoo') return `DATA_SOURCE=${md.feed} in BE/.env decides prices on this server.`;
    if (md.error) return `Not streaming: ${md.error}`;
    if (md.providedByYou) return md.kiteStreaming ? `Streaming ${md.subscribed} symbols from your Kite key.` : 'Starting the Kite price stream…';
    if (md.kiteStreaming) return 'Live prices are streaming from another connected paid key.';
    return connected ? 'Not streaming yet — it starts within a minute of connecting.' : 'Streams once you connect.';
  })();

  return (
    <Card
      title="Zerodha (Kite Connect)"
      action={
        <div className="flex items-center gap-2">
          {live && <Badge tone="red">LIVE</Badge>}
          <Badge tone={status.tone}>{conn.configured ? status.label : 'Not set up'}</Badge>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          Connect your own Zerodha account through your own Kite Connect app. Nothing trades for real until you switch
          live trading on below.
        </p>

        {conn.envBroker !== 'paper' && (
          <Notice tone="red">
            BROKER={conn.envBroker} is set in BE/.env, so every user&apos;s orders already go to that one account. Set
            BROKER=paper to use per-user connections.
          </Notice>
        )}
        {error && <Notice tone="red">{error}</Notice>}

        <Section title="Plan">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className={paid ? 'text-zinc-400' : 'font-medium text-zinc-800 dark:text-zinc-100'}>Free · Personal</span>
            <ToggleSwitch
              on={paid}
              busy={busy === 'plan'}
              disabled={live}
              title={live ? 'Switch to paper before changing the plan' : 'Free (Personal) or Paid (Kite Connect)'}
              label={paid ? 'Paid' : 'Free'}
              onToggle={togglePlan}
            />
            <span className={paid ? 'font-medium text-zinc-800 dark:text-zinc-100' : 'text-zinc-400'}>
              Paid · Kite Connect ₹500/mo
            </span>
          </div>
          <p className="text-xs text-zinc-500">{PLAN_COPY[plan]}</p>
          {paid && conn.configured && <p className="text-xs text-zinc-500">Live prices: {feedLine}</p>}
        </Section>

        <Section title="API keys">
          {!conn.credentialsKey.configured && (
            <Notice tone="amber">
              BROKER_CREDENTIALS_KEY is not set in BE/.env, so keys cannot be stored safely. Add a 64-character hex key
              and restart the backend.
            </Notice>
          )}
          {conn.configured && conn.credentialsKey.configured && !conn.credentialsKey.matches && (
            <Notice tone="red">
              These keys were saved under a different BROKER_CREDENTIALS_KEY and can no longer be read. Enter them again.
            </Notice>
          )}

          {conn.configured && !editingKeys ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm">
                <span className="text-xs text-zinc-500">API key </span>
                <code className="font-mono">{conn.apiKeyMasked}</code>
                <span className="text-xs text-zinc-400"> · secret stored encrypted</span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={BTN}
                  disabled={!!busy || live}
                  title={live ? 'Switch to paper first' : undefined}
                  onClick={() => setEditingKeys(true)}
                >
                  Replace keys
                </button>
                <button
                  type="button"
                  className={BTN_DANGER}
                  disabled={!!busy || live}
                  title={live ? 'Switch to paper first' : undefined}
                  onClick={removeKeys}
                >
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={saveKeys} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                  API key
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    disabled={!conn.credentialsKey.configured}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className={`${INPUT} font-mono`}
                  />
                </label>
                <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                  API secret
                  <input
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    required
                    disabled={!conn.credentialsKey.configured}
                    value={apiSecret}
                    onChange={(e) => setApiSecret(e.target.value)}
                    className={`${INPUT} font-mono`}
                  />
                </label>
              </div>
              <p className="text-xs text-zinc-400">
                The secret is encrypted on the server and never shown again. Saving new keys ends the current session.
              </p>
              <div className="flex gap-2">
                <button type="submit" className={BTN_PRIMARY} disabled={busy === 'keys' || !conn.credentialsKey.configured}>
                  {busy === 'keys' ? 'Saving…' : 'Save keys'}
                </button>
                {conn.configured && (
                  <button
                    type="button"
                    className={BTN}
                    disabled={busy === 'keys'}
                    onClick={() => {
                      setEditingKeys(false);
                      setApiKey('');
                      setApiSecret('');
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}

          <details className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <summary className="cursor-pointer font-medium text-zinc-700 dark:text-zinc-200">How to set up your Kite app</summary>
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-zinc-600 dark:text-zinc-300">
              <li>
                Sign in at developers.kite.trade and create an app on the free Personal plan or the paid Kite Connect
                plan. Each Zerodha account needs its own app.
              </li>
              <li>
                Set the app&apos;s Redirect URL to exactly:
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <code className="rounded bg-zinc-100 px-2 py-1 font-mono text-xs break-all dark:bg-zinc-900">
                    {conn.redirectUrl}
                  </code>
                  <Copy text={conn.redirectUrl} />
                </div>
              </li>
              <li>
                Under Profile → IP Whitelist, add this server&apos;s public IP. Kite refuses orders from any other IP.
                {conn.staticIp
                  ? ` BROKER_STATIC_IP is ${conn.staticIp}; the server halts orders if its IP changes.`
                  : ' Also set BROKER_STATIC_IP in BE/.env to the same IP, so the server halts orders if its IP changes.'}{' '}
                Test connection shows the current public IP.
              </li>
              <li>Copy the app&apos;s API key and API secret into the form above.</li>
              <li>
                To sell delivery shares from the app, enable DDPI in Zerodha Console. Without it Kite asks for a CDSL TPIN
                authorisation, and the bot&apos;s sells are refused.
              </li>
            </ol>
          </details>
        </Section>

        <Section title="Connection">
          {!conn.configured ? (
            <p className="text-sm text-zinc-500">Save your API key and secret above, then connect here.</p>
          ) : connected ? (
            <p className="text-sm text-zinc-700 dark:text-zinc-200">
              Connected as <span className="font-medium">{conn.kiteUserName ?? conn.kiteUserId}</span>
              {conn.kiteUserId ? ` (${conn.kiteUserId})` : ''}.
              {conn.expiresAt
                ? ` Session ends ${istDateTime(conn.expiresAt, false)} IST${now ? ` — in ${formatDuration(conn.expiresAt - now)}` : ''}.`
                : ''}
            </p>
          ) : conn.status === 'expired' ? (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              The session ended. Kite logs every app out at 06:00 IST, so connect again each trading day
              {live ? ' — live orders are refused until you do' : ''}.
            </p>
          ) : conn.status === 'error' ? (
            <p className="text-sm text-rose-600 dark:text-rose-400">{conn.lastError}</p>
          ) : (
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
              Not connected. Connecting opens Kite&apos;s login page and brings you back here.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BTN_PRIMARY} disabled={!!busy || !keyOk} onClick={connect}>
              {busy === 'login' ? 'Opening Kite…' : connected ? 'Reconnect' : 'Connect Zerodha'}
            </button>
            {connected && (
              <button type="button" className={BTN} disabled={!!busy} onClick={runTest}>
                {busy === 'test' ? 'Testing…' : 'Test connection'}
              </button>
            )}
            {connected && (
              <button type="button" className={BTN} disabled={!!busy} onClick={disconnect}>
                Disconnect
              </button>
            )}
          </div>
          {test && <TestResult test={test} conn={conn} />}
        </Section>

        <Section title="Trading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className={`text-sm font-medium ${live ? 'text-rose-700 dark:text-rose-300' : 'text-zinc-800 dark:text-zinc-100'}`}>
                {live ? 'Live — real orders on your Zerodha account' : 'Paper — simulated fills, no real money'}
              </div>
              {live && conn.liveSince && (
                <div className="text-xs text-zinc-500">since {istDateTime(conn.liveSince, false)} IST</div>
              )}
            </div>
            <ToggleSwitch
              on={live}
              busy={busy === 'mode'}
              disabled={!live && blockers.length > 0}
              title={!live && blockers.length ? 'See what blocks live trading below' : undefined}
              label="Live trading"
              onToggle={() => (live ? goPaper() : setConfirmLive(true))}
            />
          </div>

          {!live && blockers.length > 0 && (
            <div className="text-xs text-zinc-500">
              Before live trading:
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              {paperBlocked && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  <p>
                    <strong>Clear paper lots</strong>{' '}closes the simulated shares and the simulated cash-sweep units at
                    today&apos;s price, on paper only. No order is sent to Zerodha and your real account is not touched. The
                    lots are kept in their history, marked as cleared, and are not counted as trades.
                  </p>
                  <button
                    type="button"
                    className={`${BTN} mt-2`}
                    disabled={!!busy}
                    onClick={clearPaper}
                  >
                    {busy === 'clear' ? 'Clearing…' : 'Clear paper lots'}
                  </button>
                </div>
              )}
            </div>
          )}

          {!live && conn.liveVenueBooks.length > 0 && (
            <Notice tone="amber">
              Paused while on paper, because they hold shares bought live: {conn.liveVenueBooks.join(', ')}.
            </Notice>
          )}

          {confirmLive && !live && (
            <form onSubmit={goLive} className="space-y-3 rounded-lg border border-rose-200 p-3 dark:border-rose-900">
              <Notice tone="red">
                Live trading places real orders with real money on Zerodha client {conn.kiteUserId}. The bots trade on
                their own while the market is open. Losses are yours.
              </Notice>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                  Your ISMTA password
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={INPUT}
                  />
                </label>
                {user?.totpEnabled && (
                  <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                    Authenticator code
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={7}
                      required
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="123 456"
                      className={`${INPUT} font-mono tracking-widest`}
                    />
                  </label>
                )}
              </div>
              <label className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-0.5"
                />
                I understand real orders will be placed on my Zerodha account.
              </label>
              {/* The card-level notice sits far above this form, out of view when it is open. */}
              {error && <Notice tone="red">{error}</Notice>}
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={busy === 'mode' || !acknowledged || !password}
                >
                  {busy === 'mode' ? 'Switching…' : 'Switch to live'}
                </button>
                <button
                  type="button"
                  className={BTN}
                  disabled={busy === 'mode'}
                  onClick={() => {
                    setConfirmLive(false);
                    setPassword('');
                    setCode('');
                    setAcknowledged(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </Section>
      </div>
    </Card>
  );
}

function TestResult({
  test,
  conn,
}: {
  test: { result: BrokerTestResult; publicIp: string | null };
  conn: BrokerConnectionView;
}) {
  const { result, publicIp } = test;
  const ipMismatch = !!(conn.staticIp && publicIp && conn.staticIp !== publicIp);
  const mdLabel =
    result.marketData.status === 'available'
      ? 'available (paid plan)'
      : result.marketData.status === 'not_on_plan'
        ? 'not on this plan (free Personal)'
        : 'could not tell';
  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-zinc-500">Account</dt>
          <dd>
            {result.profile.userName} ({result.profile.userId})
          </dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Cash for delivery buys</dt>
          <dd>
            {inr(result.funds.cash, 0)}
            <span className="text-xs text-zinc-400"> · used {inr(result.funds.usedMargin, 0)}</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Market data</dt>
          <dd>{mdLabel}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">This server&apos;s public IP</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <code className="font-mono">{publicIp ?? 'unknown'}</code>
            {publicIp && <Copy text={publicIp} />}
          </dd>
        </div>
      </dl>
      {result.planMismatch && <Notice tone="amber">{result.planMismatch}</Notice>}
      {ipMismatch && (
        <Notice tone="red">
          The public IP {publicIp} is not BROKER_STATIC_IP ({conn.staticIp}). Kite will refuse orders, and the server
          halts trading while they differ.
        </Notice>
      )}
      <div>
        <div className="mb-1 text-xs text-zinc-500">
          Shares Kite reports ({result.held.length}). Total = settled + T1 + today&apos;s delivery trades — the number
          reconciliation compares your books with.
        </div>
        {result.held.length === 0 ? (
          <p className="text-xs text-zinc-400">No holdings or delivery positions.</p>
        ) : (
          <div className="max-h-56 overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className="py-1 pr-3 text-left">Symbol</th>
                  <th className="py-1 pr-3 text-right">Settled</th>
                  <th className="py-1 pr-3 text-right">T1</th>
                  <th className="py-1 pr-3 text-right">Today</th>
                  <th className="py-1 pr-3 text-right">Sold today</th>
                  <th className="py-1 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {result.held.map((h) => (
                  <tr key={h.symbol} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-1 pr-3 font-sans">{h.symbol}</td>
                    <td className="py-1 pr-3 text-right">{h.holdings}</td>
                    <td className="py-1 pr-3 text-right">{h.t1}</td>
                    <td className="py-1 pr-3 text-right">{h.todayCnc}</td>
                    <td className="py-1 pr-3 text-right">{h.usedToday}</td>
                    <td className="py-1 text-right font-semibold">{h.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
