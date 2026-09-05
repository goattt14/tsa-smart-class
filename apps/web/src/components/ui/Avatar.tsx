import { initials } from '../../lib/format';
import { cn } from '../../lib/cn';

export function Avatar({
  name,
  url,
  size = 36,
  className,
}: {
  name: string;
  url?: string | null;
  size?: number;
  className?: string;
}) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        className={cn('rounded-full object-cover', className)}
      />
    );
  }

  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-brand-tint font-semibold text-brand-deep',
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
