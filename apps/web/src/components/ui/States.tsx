import type { ReactNode } from 'react';
import { ApiError } from '../../lib/api-client';
import { Button } from './Button';

/**
 * An empty screen is an invitation to act, not an apology. Each of these takes
 * a specific line about what to do next rather than a generic "no data found".
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <p className="font-display text-[17px] font-semibold text-ink">{title}</p>
      <p className="max-w-sm text-[13.5px] leading-relaxed text-ink-muted">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/**
 * Errors explain what happened and what to do. A 403 is not a failure of the
 * app, so it gets its own wording rather than a red "something went wrong".
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const isApiError = error instanceof ApiError;
  const status = isApiError ? error.status : undefined;

  const title =
    status === 403
      ? 'Not available to you'
      : status === 404
        ? 'Not found'
        : status === 0 || status === undefined
          ? 'Could not reach the server'
          : 'That did not load';

  const body = isApiError
    ? error.message
    : 'The server did not respond. Check your connection and try again.';

  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <p className="font-display text-[17px] font-semibold text-ink">{title}</p>
      <p className="max-w-sm text-[13.5px] leading-relaxed text-ink-muted">{body}</p>
      {onRetry && status !== 403 ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Grey placeholder blocks while data loads, sized to the real content. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 px-5 py-4" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="h-11 animate-pulse rounded-lg bg-surface-sunken motion-reduce:animate-none"
          style={{ width: `${100 - index * 7}%` }}
        />
      ))}
    </div>
  );
}
