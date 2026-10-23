'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, shellApi } from '../lib/api';
import { useAuth } from '../providers/AuthProvider';
import BrandMark from '../components/BrandMark';

const INPUT =
  'mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';

/** The same rules the server applies, checked as you type so the form says what is missing. */
function passwordProblems(password: string, email: string): string[] {
  const out: string[] = [];
  if (password.length < 10) out.push('at least 10 characters');
  if (!/[A-Za-z]/.test(password)) out.push('a letter');
  if (!/\d/.test(password)) out.push('a number');
  const e = email.trim().toLowerCase();
  if (e && (password.toLowerCase() === e || password.toLowerCase() === e.split('@')[0])) out.push('not your email');
  return out;
}

/**
 * Create an account. Each account has its own stocks, paper money, Zerodha
 * connection and tax report; nothing is shared with any other account. After
 * signing up the new user lands in Settings to connect their own Zerodha.
 */
export default function SignupPage() {
  const { user, loading, register } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState<boolean | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Set once this page has created the account, so the 'already signed in'
  // redirect below does not race the redirect to the welcome page.
  const created = useRef(false);

  useEffect(() => {
    if (!loading && user && !created.current) router.replace('/dashboard');
  }, [loading, user, router]);

  useEffect(() => {
    let alive = true;
    shellApi
      .authConfig()
      .then((c) => alive && setOpen(c.registrationOpen))
      .catch(() => alive && setOpen(false));
    return () => {
      alive = false;
    };
  }, []);

  const problems = passwordProblems(password, email);
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = !busy && email.trim() && problems.length === 0 && confirm === password;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setMessage(null);
    try {
      created.current = true;
      await register(email.trim(), password, name.trim() || undefined);
      router.replace('/settings?welcome=1');
    } catch (err) {
      created.current = false;
      setMessage(err instanceof ApiError || err instanceof Error ? err.message : 'Sign-up failed');
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

        {open === false ? (
          <div className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
            <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">Sign-up is closed</h1>
            <p className="mt-2">New accounts are not being accepted on this server. Ask the person who runs it.</p>
            <Link href="/login" className="mt-4 inline-block text-sm font-medium text-blue-600 hover:underline">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">Create your account</h1>
            <p className="mt-1 text-xs text-zinc-500">
              Your own stocks, paper money and Zerodha connection. Nothing is shared with other accounts.
            </p>

            <label className="mt-4 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
              Name <span className="font-normal text-zinc-400">(optional)</span>
              <input
                id="signup-name"
                type="text"
                name="name"
                autoComplete="name"
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={INPUT}
                disabled={busy}
              />
            </label>

            <label className="mt-3 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
              Email
              <input
                id="signup-email"
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
                id="signup-password"
                type="password"
                name="new-password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={INPUT}
                disabled={busy}
                aria-describedby="signup-password-help"
              />
            </label>
            <p
              id="signup-password-help"
              className={`mt-1 text-[11px] ${password && problems.length ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-400'}`}
            >
              {password && problems.length ? `Still needs: ${problems.join(', ')}.` : 'At least 10 characters, with a letter and a number.'}
            </p>

            <label className="mt-3 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
              Confirm password
              <input
                id="signup-confirm"
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={`${INPUT} ${mismatch ? 'border-rose-400' : ''}`}
                disabled={busy}
              />
            </label>
            {mismatch && <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">The two passwords do not match.</p>}

            {message && (
              <p role="alert" className="mt-3 text-xs text-rose-600 dark:text-rose-400">
                {message}
              </p>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-5 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? 'Creating your account…' : 'Create account'}
            </button>

            <p className="mt-4 text-center text-xs text-zinc-500">
              Already have an account?{' '}
              <Link href="/login" className="font-medium text-blue-600 hover:underline">
                Sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
