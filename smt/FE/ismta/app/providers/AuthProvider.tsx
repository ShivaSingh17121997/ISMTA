'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError, clearToken, getToken, setToken, shellApi } from '../lib/api';
import type { AuthUser } from '../lib/types';

interface AuthState {
  user: AuthUser | null;
  /** True while the stored token (or the dev auto-login) is being checked. */
  loading: boolean;
  /** Set when the backend could not be reached at all — not for a wrong password. */
  error: string | null;
}

interface AuthContextValue extends AuthState {
  /** Throws `ApiError` (401 with `totpRequired`, 429 when rate limited). */
  login: (email: string, password: string, code?: string) => Promise<AuthUser>;
  /** Create an account and sign in to it. Throws `ApiError` with the server's reason. */
  register: (email: string, password: string, name?: string) => Promise<AuthUser>;
  logout: () => void;
  /** Re-read /me — after two-factor is switched on or off. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  error: null,
  login: async () => {
    throw new Error('AuthProvider missing');
  },
  register: async () => {
    throw new Error('AuthProvider missing');
  },
  logout: () => {},
  refresh: async () => {},
});

// Demo credentials seeded by the backend on first boot.
const DEMO_EMAIL = 'demo@trader.in';
const DEMO_PASSWORD = 'demo123';

/**
 * Dev convenience, OFF unless NEXT_PUBLIC_DEMO_AUTOLOGIN=true: signs the seeded
 * demo account in automatically. It used to be on by default in development,
 * which with sign-up open would drop every new visitor into the demo account.
 * Never in a production build.
 */
const DEMO_AUTOLOGIN =
  process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_DEMO_AUTOLOGIN === 'true';

/**
 * Set by `logout()` for the rest of the tab's life so the dev auto-login does
 * not sign the user straight back in; cleared by an explicit login. A fresh
 * tab still auto-logs in.
 */
const LOGGED_OUT_KEY = 'ismta_logged_out';

function loggedOutByHand(): boolean {
  try {
    return sessionStorage.getItem(LOGGED_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

function setLoggedOutByHand(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(LOGGED_OUT_KEY, '1');
    else sessionStorage.removeItem(LOGGED_OUT_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (getToken()) {
          try {
            const { user } = await shellApi.me();
            if (!cancelled) setState({ user, loading: false, error: null });
            return;
          } catch (e) {
            // A dead token has already been dropped by `request()`; fall
            // through to the demo login in dev, or to the login page.
            if (!(e instanceof ApiError && e.status === 401)) throw e;
          }
        }
        if (DEMO_AUTOLOGIN && !loggedOutByHand()) {
          try {
            const { token, user } = await shellApi.login(DEMO_EMAIL, DEMO_PASSWORD);
            setToken(token);
            if (!cancelled) setState({ user, loading: false, error: null });
            return;
          } catch (e) {
            // Demo password changed, two-factor switched on for it, or rate
            // limited: the form can sort that out. Anything else is the
            // backend being unreachable.
            if (!(e instanceof ApiError && (e.status === 401 || e.status === 429))) throw e;
          }
        }
        if (!cancelled) setState({ user: null, loading: false, error: null });
      } catch (e) {
        if (!cancelled) {
          setState({
            user: null,
            loading: false,
            error: e instanceof Error ? e.message : 'Login failed',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string, code?: string) => {
    const { token, user } = await shellApi.login(email, password, code);
    setToken(token);
    setLoggedOutByHand(false);
    setState({ user, loading: false, error: null });
    return user;
  }, []);

  const register = useCallback(async (email: string, password: string, name?: string) => {
    const { token, user } = await shellApi.register(email, password, name);
    setToken(token);
    setLoggedOutByHand(false);
    setState({ user, loading: false, error: null });
    return user;
  }, []);

  const refresh = useCallback(async () => {
    const { user } = await shellApi.me();
    setState({ user, loading: false, error: null });
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setLoggedOutByHand(true);
    setState({ user: null, loading: false, error: null });
    // A full navigation rather than a router push: it drops the WebSocket,
    // every poller and every piece of per-user state in one move.
    window.location.replace('/login');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, register, logout, refresh }),
    [state, login, register, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
