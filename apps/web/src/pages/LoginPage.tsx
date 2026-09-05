import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { FullPageSpinner } from '../components/ui/Spinner';
import { apiPost, ApiError } from '../lib/api-client';
import { env } from '../config/env';

type Mode = 'sign-in' | 'forgot' | 'reset';

export function LoginPage() {
  const { user, isBootstrapping, isSigningIn, error, signIn } = useAuth();
  const location = useLocation() as { state?: { from?: string } };

  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isBootstrapping) return <FullPageSpinner label="Checking your session" />;
  if (user) return <Navigate to={location.state?.from ?? '/'} replace />;

  async function handleSignIn(event: FormEvent) {
    event.preventDefault();
    try {
      await signIn(email, password);
    } catch {
      // The provider already surfaced the message.
    }
  }

  async function handleForgot(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setLocalError(null);

    try {
      const result = await apiPost<{ message: string; devToken?: string }>(
        '/auth/forgot-password',
        { email },
      );
      // Outside production the API returns the token so the flow is testable
      // without a mail provider configured.
      if (result.devToken) {
        setToken(result.devToken);
        setMode('reset');
        setNotice('Development mode: the reset token has been filled in for you.');
      } else {
        setNotice(result.message);
      }
    } catch (caught) {
      setLocalError(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  async function handleReset(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setLocalError(null);

    try {
      await apiPost('/auth/reset-password', { token, newPassword });
      setMode('sign-in');
      setPassword('');
      setNotice('Password updated. Sign in with the new one.');
    } catch (caught) {
      setLocalError(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page flex min-h-screen">
      {/* ---------- brand panel ---------- */}
      <div className="login-hero hidden flex-col justify-between bg-ink p-12 text-white lg:flex lg:w-[42%]">
        <div className="hero-brand flex flex-col items-start gap-4">
          <img src="/tsa-logo.png" alt="The Scholastic Academy" className="h-12 w-12 rounded-2xl object-cover" />
          <div>
          <div className="hero-brand-name font-display text-4xl font-extrabold leading-none text-brand">
            {env.APP_SHORT_NAME}
          </div>
          <div className="hero-brand-tagline font-display text-[13px] italic text-white/45">
            {env.APP_TAGLINE}
          </div>
          </div>
        </div>

        <div className="hero-copy">
          <h2 className="font-display text-[32px] font-semibold leading-tight text-white">
            Class ends.
            <br />
            <span className="text-brand-soft">The evening plans itself.</span>
          </h2>
        </div>

        <p className="text-[12px] text-white/35">{env.APP_NAME}</p>
        <div className="mobile-scroll-cue" aria-hidden="true">
          <span className="mobile-scroll-arrow">↓</span>
          <span>Scroll to Sign In</span>
        </div>
      </div>

      {/* ---------- form panel ---------- */}
      <div className="login-form-panel flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mobile-form-brand lg:hidden">
            <div className="flex items-center gap-2.5">
              <img src="/tsa-logo.png" alt="The Scholastic Academy" className="h-9 w-9 rounded-xl object-cover" />
              <div className="font-display text-3xl font-bold text-brand">{env.APP_SHORT_NAME}</div>
            </div>
            <div className="mb-8 mt-0.5 font-display text-[12px] italic text-ink-muted">
              {env.APP_TAGLINE}
            </div>
          </div>

          {mode === 'sign-in' ? (
            <form onSubmit={handleSignIn} className="space-y-4" noValidate>
              <div>
                <h1 className="font-display text-[26px] font-semibold text-ink">Sign in</h1>
                <p className="mt-1 text-[14px] text-ink-muted">Use the account your institute gave you.</p>
              </div>

              {notice ? (
                <div className="rounded-lg bg-brand-tint px-3.5 py-2.5 text-[13px] text-brand-deep">
                  {notice}
                </div>
              ) : null}

              <Field
                label="Email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@tsa.edu.in"
              />

              <Field
                label="Password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                error={error ?? undefined}
              />

              <Button type="submit" size="lg" loading={isSigningIn} className="w-full">
                Sign in
              </Button>

              <button
                type="button"
                onClick={() => {
                  setMode('forgot');
                  setNotice(null);
                }}
                className="w-full text-[13px] text-ink-muted underline-offset-2 hover:text-ink hover:underline"
              >
                Forgotten your password?
              </button>
            </form>
          ) : null}

          {mode === 'forgot' ? (
            <form onSubmit={handleForgot} className="space-y-4" noValidate>
              <div>
                <h1 className="font-display text-[26px] font-semibold text-ink">Reset password</h1>
                <p className="mt-1 text-[14px] text-ink-muted">
                  We will send a link if that address is registered.
                </p>
              </div>

              {notice ? (
                <div className="rounded-lg bg-brand-tint px-3.5 py-2.5 text-[13px] text-brand-deep">
                  {notice}
                </div>
              ) : null}

              <Field
                label="Email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                error={localError ?? undefined}
              />

              <Button type="submit" size="lg" loading={busy} className="w-full">
                Send reset link
              </Button>

              <button
                type="button"
                onClick={() => setMode('sign-in')}
                className="w-full text-[13px] text-ink-muted hover:text-ink"
              >
                Back to sign in
              </button>
            </form>
          ) : null}

          {mode === 'reset' ? (
            <form onSubmit={handleReset} className="space-y-4" noValidate>
              <div>
                <h1 className="font-display text-[26px] font-semibold text-ink">Choose a new password</h1>
              </div>

              {notice ? (
                <div className="rounded-lg bg-brand-tint px-3.5 py-2.5 text-[13px] text-brand-deep">
                  {notice}
                </div>
              ) : null}

              <Field
                label="Reset token"
                required
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />

              <Field
                label="New password"
                type="password"
                autoComplete="new-password"
                required
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                hint="At least 10 characters, with a number."
                error={localError ?? undefined}
              />

              <Button type="submit" size="lg" loading={busy} className="w-full">
                Update password
              </Button>
            </form>
          ) : null}
        </div>
      </div>
    </div>
  );
}
