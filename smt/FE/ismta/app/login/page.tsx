'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { ApiError, shellApi } from '../lib/api';
import { useAuth } from '../providers/AuthProvider';
import BrandMark from '../components/BrandMark';


/** Where to go after login: the `next` query param when it is a safe in-app path. */
function nextPath(): string {
  try {
    const n = new URLSearchParams(window.location.search).get('next');
    if (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/login') && !n.startsWith('/signup')) return n;
  } catch {
    /* no window */
  }
  return '/dashboard';
}

const INPUT =
  'mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';

/**
 * Login. Email and password; when the server answers `totpRequired` the
 * 6-digit code field appears and the same form is resubmitted with it.
 * The route is rate limited to 10 attempts a minute, and a 429 is shown as
 * such rather than as "wrong password".
 */
export default function LoginPage() {
  const { user, loading, error: backendError, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [signupOpen, setSignupOpen] = useState(false);

  // Offer "Create an account" only when the server accepts sign-ups.
  useEffect(() => {
    let alive = true;
    shellApi
      .authConfig()
      .then((c) => alive && setSignupOpen(c.registrationOpen))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Already signed in (stored token, or the dev auto-login): nothing to do here.
  useEffect(() => {
    if (!loading && user) router.replace(nextPath());
  }, [loading, user, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await login(email.trim(), password, needCode ? code.replace(/\s+/g, '') : undefined);
      router.replace(nextPath());
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setMessage({ tone: 'error', text: err.message || 'Too many attempts. Wait a minute and try again.' });
        } else if (err.status === 401 && err.totpRequired) {
          if (needCode) {
            setMessage({ tone: 'error', text: 'That code did not match. Check the app and the clock, then try again.' });
          } else {
            setNeedCode(true);
            setMessage({
              tone: 'info',
              text: 'This account has two-factor authentication on. Enter the 6-digit code from your authenticator app.',
            });
          }
        } else {
          setMessage({ tone: 'error', text: err.message });
        }
      } else {
        setMessage({ tone: 'error', text: err instanceof Error ? err.message : 'Login failed' });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 py-8 dark:bg-black">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-3">
          <BrandMark size={36} />
          <div>
            <div className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">ISMTA</div>
            <div className="text-xs text-zinc-500">NSE trading terminal</div>
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
        >
          <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">Sign in</h1>
          <p className="mt-1 text-xs text-zinc-500">
            {loading ? 'Checking your session…' : 'Sign in with your email and password.'}
          </p>

          {backendError && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
              The backend could not be reached: {backendError}
            </div>
          )}

          <label className="mt-4 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
            Email
            <input
              id="login-email"
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={INPUT}
              disabled={busy}
            />
          </label>

          <label className="mt-3 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
            Password
            <input
              id="login-password"
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={INPUT}
              disabled={busy}
            />
          </label>

          {needCode && (
            <label className="mt-3 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
              Authenticator code
              <input
                type="text"
                name="code"
                inputMode="numeric"
                pattern="[0-9 ]*"
                autoComplete="one-time-code"
                maxLength={7}
                autoFocus
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123 456"
                className={`${INPUT} font-mono tracking-widest`}
                disabled={busy}
              />
            </label>
          )}

          {message && (
            <p
              role={message.tone === 'error' ? 'alert' : 'status'}
              className={`mt-3 text-xs ${
                message.tone === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-blue-700 dark:text-blue-300'
              }`}
            >
              {message.text}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-5 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Signing in…' : needCode ? 'Verify and sign in' : 'Sign in'}
          </button>
        </form>

        {signupOpen && (
          <p className="mt-4 text-center text-xs text-zinc-500">
            New here?{' '}
            <Link href="/signup" className="font-medium text-blue-600 hover:underline">
              Create an account
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
