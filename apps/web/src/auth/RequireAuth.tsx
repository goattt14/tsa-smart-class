import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';
import { FullPageSpinner } from '../components/ui/Spinner';

/**
 * Gate for signed-in routes.
 *
 * Waits for the silent refresh to finish before deciding. Redirecting during
 * bootstrap would bounce a signed-in user to the login screen on every reload.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isBootstrapping } = useAuth();
  const location = useLocation();

  if (isBootstrapping) return <FullPageSpinner label="Signing you in" />;

  if (!user) {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}

/**
 * Gate for a route that needs a specific permission.
 *
 * The server enforces this too — this only stops the user reaching a screen
 * that would fail. Never rely on the client for access control.
 */
export function RequirePermission({
  permission,
  children,
}: {
  permission: string;
  children: ReactNode;
}) {
  const { can } = useAuth();

  if (!can(permission)) {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <h2 className="font-display text-2xl text-ink">Not available to you</h2>
        <p className="mt-2 text-ink-muted">
          Your role does not include this screen. If you think that is wrong, ask your
          administrator.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
