import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * A single figure with its label.
 *
 * `value` is set in the monospace face so a column of numbers lines up and a
 * changing percentage does not make the layout jitter.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'positive' | 'caution' | 'critical';
  icon?: ReactNode;
}) {
  const valueTone = {
    default: 'text-ink',
    positive: 'text-positive',
    caution: 'text-caution',
    critical: 'text-critical',
  }[tone];

  return (
    <div className="card rounded-card border border-line bg-surface-raised px-5 py-4">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        {icon}
        {label}
      </div>
      <div className={cn('mt-1.5 font-mono text-[26px] font-semibold leading-none tabular-nums', valueTone)}>
        {value}
      </div>
      {hint ? <p className="mt-1.5 text-[12px] leading-snug text-ink-muted">{hint}</p> : null}
    </div>
  );
}
