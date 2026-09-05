import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cn('card rounded-card border border-line bg-surface-raised', className)}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div>
        <h2 className="font-display text-[17px] font-semibold leading-tight text-ink">{title}</h2>
        {hint ? <p className="mt-0.5 text-[13px] text-ink-muted">{hint}</p> : null}
      </div>
      {action}
    </header>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}
