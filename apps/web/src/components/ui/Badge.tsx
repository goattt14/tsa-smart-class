import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type Tone = 'neutral' | 'brand' | 'positive' | 'caution' | 'critical';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-sunken text-ink-soft',
  brand: 'bg-brand-tint text-brand-deep',
  positive: 'bg-positive-tint text-positive',
  caution: 'bg-caution-tint text-caution',
  critical: 'bg-critical-tint text-critical',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Maps the API's status strings onto a tone, in one place. */
export function toneForStatus(status: string): Tone {
  switch (status.toUpperCase()) {
    case 'COMPLETED':
    case 'PAID':
    case 'ON_TIME':
    case 'PRESENT':
    case 'EVALUATED':
    case 'PUBLISHED':
      return 'positive';
    case 'IN_PROGRESS':
    case 'ONGOING':
    case 'PARTIAL':
    case 'PENDING_REVIEW':
    case 'SUBMITTED':
      return 'brand';
    case 'PENDING':
    case 'LATE':
    case 'SCHEDULED':
    case 'NOTIFIED':
      return 'caution';
    case 'MISSED':
    case 'MISSING':
    case 'OVERDUE':
    case 'ABSENT':
    case 'CANCELLED':
    case 'FAILED':
      return 'critical';
    default:
      return 'neutral';
  }
}
