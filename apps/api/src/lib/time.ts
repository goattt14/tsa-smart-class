/**
 * Time helpers for scheduling.
 *
 * Two conventions run through the whole scheduler and are worth stating once:
 *
 * 1. Times of day are integers: minutes from midnight. 21:30 is 1290. No Date
 *    object is involved, so no timezone can silently shift a lecture slot.
 *
 * 2. Calendar dates are 'YYYY-MM-DD' strings, not Date objects. `new Date()`
 *    on a Render box running UTC and on a phone in IST disagree about which
 *    day it is for five and a half hours every night — exactly the window this
 *    product schedules study sessions in. Strings sidestep that entirely; the
 *    conversion to a Date happens once, at the Prisma boundary.
 */

export const MINUTES_PER_DAY = 1440;

export const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
export type WeekdayCode = (typeof WEEKDAYS)[number];

/** 14:30 -> 870 */
export function toMinutes(hours: number, minutes = 0): number {
  return hours * 60 + minutes;
}

/** 1290 -> "21:30". Values beyond a day wrap, so 1470 renders as "00:30". */
export function formatMinutes(value: number): string {
  const wrapped = ((value % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Rounds up to the next multiple of `step`, so schedules land on clean times. */
export function roundUpTo(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.ceil(value / step) * step;
}

/** Half-open interval overlap: [aStart, aEnd) against [bStart, bEnd). */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Validates and normalises a 'YYYY-MM-DD' string. */
export function isDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Calendar arithmetic on the string itself, via UTC so no local offset applies. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return toDateString(shifted);
}

export function toDateString(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** A UTC-midnight Date, which is how Prisma expects a @db.Date value. */
export function toUtcDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export function weekdayOf(date: string): WeekdayCode {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const index = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return WEEKDAYS[index] as WeekdayCode;
}

export function isWeekend(date: string): boolean {
  const day = weekdayOf(date);
  return day === 'SAT' || day === 'SUN';
}

/**
 * Today's date and clock position in a given IANA zone, derived from a real
 * instant. Used by the scheduler so "today" means today in Mumbai, not on the
 * server.
 */
export function nowInZone(
  timeZone: string,
  instant: Date = new Date(),
): { date: string; minutes: number; weekday: WeekdayCode } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = new Map(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  const date = `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
  // Intl renders midnight as 24 in some engines; normalise it to 0.
  const hour = Number(parts.get('hour')) % 24;
  const minutes = hour * 60 + Number(parts.get('minute'));

  return { date, minutes, weekday: weekdayOf(date) };
}

/** Inclusive list of dates from `from` to `to`, capped to avoid runaway ranges. */
export function dateRange(from: string, to: string, maxDays = 400): string[] {
  const out: string[] = [];
  let cursor = from;
  while (cursor <= to && out.length < maxDays) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}
