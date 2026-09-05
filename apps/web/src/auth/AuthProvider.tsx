import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { apiPost, ApiError } from '../lib/api-client';
import { tokenStore } from '../lib/token-store';
import type { AuthUser, LoginResponse } from '../types/api';

interface AuthState {
  user: AuthUser | null;
  /** True while the first silent refresh is still in flight. */
  isBootstrapping: boolean;
  isSigningIn: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isBootstrapping, setBootstrapping] = useState(true);
  const [isSigningIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * On load, try to trade the httpOnly refresh cookie for a new access token.
   * This is what keeps a signed-in user signed in across a page reload, since
   * the access token itself only lives in memory.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = await apiPost<LoginResponse>('/auth/refresh');
        if (cancelled) return;
        tokenStore.set(result.accessToken);
        setUser(result.user);
      } catch {
        // No valid cookie. That is the normal state for a first visit, so it
        // is not an error worth showing anyone.
        tokenStore.clear();
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    setSigningIn(true);
    setError(null);

    try {
      const result = await apiPost<LoginResponse>('/auth/login', { email, password });
      tokenStore.set(result.accessToken);
      setUser(result.user);
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.';
      setError(message);
      throw caught;
    } finally {
      setSigningIn(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiPost('/auth/logout');
    } catch {
      // Signing out locally matters more than the server acknowledging it.
    }
    tokenStore.clear();
    setUser(null);
  }, []);

  const can = useCallback(
    (permission: string) => user?.permissions.includes(permission) ?? false,
    [user],
  );

  // If a request elsewhere clears the token — a refresh-reuse revocation, say —
  // the UI must drop back to the sign-in screen rather than show empty panels.
  useEffect(
    () =>
      tokenStore.subscribe((token) => {
        if (token === null && !isBootstrapping) setUser(null);
      }),
    [isBootstrapping],
  );

  const value = useMemo<AuthState>(
    () => ({ user, isBootstrapping, isSigningIn, error, signIn, signOut, can }),
    [user, isBootstrapping, isSigningIn, error, signIn, signOut, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/** Convenience for hiding a control the signed-in user cannot use. */
export function useCan(permission: string): boolean {
  return useAuth().can(permission);
}

export { AuthContext };
