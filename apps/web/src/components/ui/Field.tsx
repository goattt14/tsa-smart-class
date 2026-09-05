import type { InputHTMLAttributes } from 'react';
import { forwardRef, useId } from 'react';
import { cn } from '../../lib/cn';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | undefined;
}

export const Field = forwardRef<HTMLInputElement, Props>(function Field(
  { label, hint, error, className, ...rest },
  ref,
) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-semibold text-ink">
        {label}
      </label>
      <input
        {...rest}
        id={id}
        ref={ref}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          'h-11 w-full rounded-lg border bg-surface-raised px-3.5 text-[15px] text-ink',
          'placeholder:text-ink-muted/70',
          'focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand',
          error ? 'border-critical' : 'border-line',
          className,
        )}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-[13px] text-critical">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-[13px] text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
