import { cn } from '../../lib/cn';

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-brand',
        'motion-reduce:animate-none',
        className,
      )}
    />
  );
}

export function FullPageSpinner({ label }: { label?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3">
      <Spinner className="h-6 w-6" />
      {label ? <p className="text-sm text-ink-muted">{label}…</p> : null}
    </div>
  );
}
