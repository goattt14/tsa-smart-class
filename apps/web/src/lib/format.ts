/**
 * Formatting helpers.
 *
 * The API sends times as minutes from midnight — never as a timestamp — so the
 * browser's own timezone can never shift a lecture slot. These helpers turn
 * that integer into something readable, and nothing here reintroduces a Date
 * where the API deliberately avoided one.
 */

export function formatMinutes(value: number): string {
  const wrapped = ((value % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  const suffix = hours < 12 ? 'am' : 'pm';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return minutes === 0
    ? `${display}${suffix}`
    : `${display}:${String(minutes).padStart(2, '0')}${suffix}`;
}

export function formatRange(startMin: number, endMin: number): string {
  return `${formatMinutes(startMin)} – ${formatMinutes(endMin)}`;
}

export function durationLabel(startMin: number, endMin: number): string {
  const total = Math.max(0, endMin - startMin);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

/** "in 2 days", "tomorrow", "3 days ago" — relative to now, in plain words. */
export function relativeDay(iso: string): string {
  const target = new Date(iso);
  const now = new Date();

  const days = Math.round(
    (Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) -
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) /
      86_400_000,
  );

  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 1) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  });
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** Falls back to the brand green when a subject has no colour set. */
export function subjectColor(hex: string | null | undefined): string {
  return hex && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#5CB82B';
}
