'use client';

import QRCode from 'qrcode';
import { FormEvent, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { BrokerConnectionCard } from '../components/BrokerConnectionCard';
import { Badge, Card, PageHeader } from '../components/ui';
import { shellApi } from '../lib/api';
import type { TotpEnrolment } from '../lib/types';
import { useAuth } from '../providers/AuthProvider';
import { ShortcutList } from '../providers/ShortcutsProvider';
import { useSystem } from '../providers/SystemProvider';
import { Theme, useTheme } from '../providers/ThemeProvider';
import { useToast } from '../providers/ToastProvider';

const INPUT =
  'mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';
const BTN =
  'rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900';
const BTN_PRIMARY =
  'rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60';

/** Shown once, right after sign-up (`?welcome=1`): what to do first. */
function WelcomeNote() {
  const params = useSearchParams();
  if (params.get('welcome') !== '1') return null;
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
      <p className="font-semibold">Welcome. Your account is ready, with its own ₹2,00,000 of paper money.</p>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        <li>Turn on two-factor sign-in below.</li>
        <li>
          Connect your own Zerodha under <strong>Zerodha (Kite Connect)</strong>: create a Personal app on
          developers.kite.trade, paste its API key and secret, then press Connect.
        </li>
        <li>
          Add stocks or index ETFs on the <strong>Accumulator</strong>{' '}page. Everything trades on paper until you switch
          live trading on yourself.
        </li>
      </ol>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Settings"
        subtitle="Account security, appearance, and the environment this terminal is talking to"
      />
      <div className="space-y-4">
        <Suspense fallback={null}>
          <WelcomeNote />
        </Suspense>
        <AccountCard />
        <TwoFactorCard />
        <PasswordCard />
        {/* Reads Kite's ?broker= redirect result, so it needs its own Suspense boundary. */}
        <Suspense fallback={<Card title="Zerodha (Kite Connect)"><p className="text-sm text-zinc-500">Loading…</p></Card>}>
          <BrokerConnectionCard />
        </Suspense>
        <AppearanceCard />
        <Card title="Keyboard shortcuts">
          <ShortcutList compact />
          <p className="mt-3 text-xs text-zinc-400">
            Press <kbd className="font-mono">?</kbd> anywhere for this list. Shortcuts are ignored while typing in a
            field.
          </p>
        </Card>
        <EnvironmentCard />
      </div>
    </div>
  );
}

function AccountCard() {
  const { user, logout } = useAuth();
  return (
    <Card
      title="Account"
      action={
        <button type="button" onClick={logout} className={BTN}>
          Sign out
        </button>
      }
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-zinc-500">Name</dt>
          <dd className="text-zinc-800 dark:text-zinc-100">{user?.name ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Email</dt>
          <dd className="truncate text-zinc-800 dark:text-zinc-100">{user?.email ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Role</dt>
          <dd className="text-zinc-800 dark:text-zinc-100">{user?.role ?? '—'}</dd>
        </div>
      </dl>
    </Card>
  );
}

/** Small helper: one in-flight action at a time, with its error. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

function QrCanvas({ text }: { text: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    QRCode.toCanvas(el, text, { width: 192, margin: 1, errorCorrectionLevel: 'M' }).catch(() => {
      /* the secret and URI are shown as text as well */
    });
  }, [text]);
  return (
    <canvas
      ref={ref}
      width={192}
      height={192}
      className="h-48 w-48 rounded-lg bg-white p-1"
      aria-label="QR code for the authenticator app"
    />
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
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
      {done ? 'Copied' : label}
    </button>
  );
}

/**
 * Two-factor. Enrol returns a secret that is not enforced until a code from
 * the app confirms it — so a mistyped secret cannot lock the account.
 * Disabling needs the password and a current code.
 */
function PasswordCard() {
  const { user } = useAuth();
  const { push } = useToast();
  const { busy, error, run, setError } = useAction();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const needsCode = !!user?.totpEnabled;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) {
      setError('The two new passwords do not match.');
      return;
    }
    run(async () => {
      await shellApi.changePassword(current, next, needsCode ? code.replace(/\s+/g, '') : undefined);
      setCurrent('');
      setNext('');
      setAgain('');
      setCode('');
      push('info', 'Password changed. Use the new one next time you sign in.');
    });
  };

  return (
    <Card title="Password">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          Live trading is refused while the account uses the published demo password.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-300">
            Current password
            <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={INPUT} />
          </label>
          {needsCode && (
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
          <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-300">
            New password (10+ characters)
            <input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} className={INPUT} />
          </label>
          <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-300">
            New password again
            <input type="password" autoComplete="new-password" required minLength={10} value={again} onChange={(e) => setAgain(e.target.value)} className={INPUT} />
          </label>
        </div>
        {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        <button type="submit" disabled={busy} className={BTN_PRIMARY}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </Card>
  );
}

function TwoFactorCard() {
  const { user, refresh } = useAuth();
  const { push } = useToast();
  const { busy, error, run, setError } = useAction();
  const [enrol, setEnrol] = useState<TotpEnrolment | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const enabled = !!user?.totpEnabled;

  const start = () =>
    run(async () => {
      const r = await shellApi.totpEnrol();
      setEnrol(r);
      setCode('');
    });

  const confirm = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await shellApi.totpConfirm(code.replace(/\s+/g, ''));
      await refresh();
      setEnrol(null);
      setCode('');
      push('info', 'Two-factor authentication is on. Signing in now needs a code from your app.');
    });
  };

  const disable = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await shellApi.totpDisable(password, code.replace(/\s+/g, ''));
      await refresh();
      setPassword('');
      setCode('');
      push('warn', 'Two-factor authentication is off. Password alone signs in now.');
    });
  };

  const cancel = () => {
    setEnrol(null);
    setCode('');
    setError(null);
  };

  const grouped = enrol ? (enrol.secret.match(/.{1,4}/g) ?? [enrol.secret]).join(' ') : '';

  return (
    <Card
      title="Two-factor authentication"
      action={enabled ? <Badge tone="green">Enabled</Badge> : <Badge tone="neutral">Off</Badge>}
    >
      {enabled ? (
        <form onSubmit={disable} className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Signing in requires a code from your authenticator app. To switch it off, confirm with your password and
            a current code.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-300">
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={INPUT}
              />
            </label>
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
          </div>
          {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40"
          >
            {busy ? 'Working…' : 'Disable two-factor'}
          </button>
        </form>
      ) : !enrol ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Adds a 6-digit code from an authenticator app (Google Authenticator, Aegis, 1Password…) to every sign-in.
            Required before switching to live trading.
          </p>
          {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
          <button type="button" onClick={start} disabled={busy} className={BTN_PRIMARY}>
            {busy ? 'Generating…' : 'Set up two-factor'}
          </button>
        </div>
      ) : (
        <form onSubmit={confirm} className="space-y-4">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-300">
            <li>Scan the QR code with your authenticator app, or type the secret in by hand.</li>
            <li>Enter the code the app shows to confirm. Sign-in will not ask for a code until you do.</li>
          </ol>
          <div className="flex flex-col gap-4 sm:flex-row">
            <QrCanvas text={enrol.uri} />
            <div className="min-w-0 flex-1 space-y-3 text-sm">
              <div>
                <div className="text-xs text-zinc-500">Secret</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  <code className="rounded bg-zinc-100 px-2 py-1 font-mono text-sm tracking-wider break-all dark:bg-zinc-900">
                    {grouped}
                  </code>
                  <CopyButton text={enrol.secret} label="Copy secret" />
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-500">otpauth URI</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  <code className="max-w-full rounded bg-zinc-100 px-2 py-1 font-mono text-[11px] break-all text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                    {enrol.uri}
                  </code>
                  <CopyButton text={enrol.uri} label="Copy URI" />
                </div>
              </div>
              <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                Code from the app
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={7}
                  required
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123 456"
                  className={`${INPUT} block max-w-[12rem] font-mono tracking-widest`}
                />
              </label>
              {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
              <div className="flex gap-2">
                <button type="submit" disabled={busy || code.replace(/\s+/g, '').length !== 6} className={BTN_PRIMARY}>
                  {busy ? 'Checking…' : 'Confirm and enable'}
                </button>
                <button type="button" onClick={cancel} disabled={busy} className={BTN}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </form>
      )}
    </Card>
  );
}

const THEMES: { value: Theme; label: string; hint: string }[] = [
  { value: 'light', label: 'Light', hint: 'Always light' },
  { value: 'dark', label: 'Dark', hint: 'Always dark' },
  { value: 'system', label: 'System', hint: 'Follow the OS setting' },
];

function AppearanceCard() {
  const { theme, resolved, setTheme } = useTheme();
  return (
    <Card title="Appearance">
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2">
        {THEMES.map((t) => {
          const on = theme === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setTheme(t.value)}
              className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                on
                  ? 'border-blue-500 bg-blue-50 text-blue-800 dark:border-blue-500 dark:bg-blue-950/40 dark:text-blue-200'
                  : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900'
              }`}
            >
              <div className="font-medium">{t.label}</div>
              <div className="text-xs text-zinc-500">{t.hint}</div>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-zinc-400">
        Currently showing the {resolved} theme{theme === 'system' ? ' (from your OS)' : ''}. Saved in this browser.
      </p>
    </Card>
  );
}

function EnvironmentCard() {
  const { system, error } = useSystem();
  if (!system) {
    return (
      <Card title="Environment">
        <p className="text-sm text-zinc-500">{error ?? 'Loading system status…'}</p>
      </Card>
    );
  }
  const live = system.broker !== 'paper';
  return (
    <Card title="Environment">
      <dl className="space-y-3 text-sm">
        <div className="flex items-start justify-between gap-4">
          <dt className="text-zinc-500">Broker</dt>
          <dd className="flex items-center gap-2">
            <Badge tone={live ? 'red' : 'amber'}>{system.broker}</Badge>
            <span className="text-xs text-zinc-400">{live ? 'real orders' : 'simulated fills, no real money'}</span>
          </dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="text-zinc-500">Data source</dt>
          <dd className="flex items-center gap-2">
            <Badge tone={system.dataSource === 'sim' ? 'amber' : 'blue'}>{system.dataSource}</Badge>
            {system.feed && (
              <span className="text-xs text-zinc-400">
                {system.feed.running ? 'feed running' : 'feed stopped'} · {system.feed.priced}/{system.feed.tracked}{' '}
                priced
              </span>
            )}
          </dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="text-zinc-500">Alerts</dt>
          <dd>
            <Badge tone={system.notifier.configured ? 'green' : 'neutral'}>
              {system.notifier.configured ? 'configured' : 'not configured'}
            </Badge>
          </dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="text-zinc-500">JWT secret</dt>
          <dd className="text-right">
            {system.jwtSecretIsDefault ? (
              <>
                <Badge tone="red">default</Badge>
                <p className="mt-1 max-w-xs text-xs text-rose-600 dark:text-rose-400">
                  Anyone with the source can forge a session. Set <code className="font-mono">JWT_SECRET</code> to a long
                  random string in <code className="font-mono">BE/.env</code> and restart the backend.
                </p>
              </>
            ) : (
              <Badge tone="green">custom</Badge>
            )}
          </dd>
        </div>
      </dl>
    </Card>
  );
}
