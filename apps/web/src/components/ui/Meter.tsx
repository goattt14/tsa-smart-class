import { cn } from '../../lib/cn';

/**
 * A horizontal bar for a percentage.
 *
 * Colour changes at thresholds that mean something to a school: 75% is the
 * usual attendance requirement, and below 50% is a real problem.
 */
export function Meter({
  value,
  label,
  showValue = true,
}: {
  value: number | null;
  label?: string;
  showValue?: boolean;
}) {
  if (value === null) {
    return <p className="text-[13px] text-ink-muted">Not enough data yet</p>;
  }

  const clamped = Math.max(0, Math.min(100, value));
  const tone = clamped >= 75 ? 'bg-positive' : clamped >= 50 ? 'bg-caution' : 'bg-critical';

  return (
    <div>
      {(label || showValue) && (
        <div className="mb-1 flex items-baseline justify-between">
          {label ? <span className="text-[12.5px] text-ink-soft">{label}</span> : <span />}
          {showValue ? (
            <span className="font-mono text-[13px] font-semibold tabular-nums text-ink">
              {Math.round(clamped)}%
            </span>
          ) : null}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
      >
        <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
