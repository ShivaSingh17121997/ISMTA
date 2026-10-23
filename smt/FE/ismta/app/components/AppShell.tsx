'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../providers/AuthProvider';
import { useLive } from '../providers/LiveProvider';
import { MobileNav, Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/**
 * The frame around every page: sidebar (desktop) or drawer (phone), top bar,
 * scrolling main. `/login` renders bare. An unauthenticated visit anywhere
 * else is sent to `/login?next=…`.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, error } = useAuth();
  const { connected } = useLive();
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);

  // Public pages, rendered bare: sign-in and sign-up.
  const isLogin =
    pathname === '/login' || pathname.startsWith('/login/') || pathname === '/signup' || pathname.startsWith('/signup/');
  const needsLogin = !loading && !user && !error && !isLogin;

  useEffect(() => {
    if (!needsLogin) return;
    const here = window.location.pathname + window.location.search;
    router.replace(here === '/' || here === '/dashboard' ? '/login' : `/login?next=${encodeURIComponent(here)}`);
  }, [needsLogin, router]);

  if (isLogin) return <>{children}</>;

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-zinc-500">
        Connecting to trading backend…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-lg font-semibold text-rose-500">Backend unavailable</div>
        <p className="max-w-md text-sm text-zinc-500">{error}</p>
        <p className="max-w-md text-xs text-zinc-400">
          Start the backend (cd BE &amp;&amp; npm run dev) and ensure NEXT_PUBLIC_API_URL points to it.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-2 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!user) {
    return <div className="flex h-screen items-center justify-center text-sm text-zinc-500">Redirecting to login…</div>;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <MobileNav open={navOpen} onClose={closeNav} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar connected={connected} onMenu={() => setNavOpen(true)} />
        <main className="flex-1 overflow-y-auto bg-zinc-50 p-4 md:p-6 dark:bg-black">{children}</main>
      </div>
    </div>
  );
}
