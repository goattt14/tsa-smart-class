import { describe, expect, it } from 'vitest';
import { computeDueAt, deriveCompliance, LOG_GRACE_HOURS } from '../modules/dailylogs/dailylogs.service';
import { toMinutes, toUtcDate } from '../lib/time';

describe('daily log deadlines', () => {
  const sessionDate = toUtcDate('2026-03-11');

  it('gives the configured grace period after the lecture ends', () => {
    const due = computeDueAt(sessionDate, toMinutes(16, 0));
    // 16:00 plus 12 hours is 04:00 the next morning.
    expect(due.toISOString()).toBe('2026-03-12T04:00:00.000Z');
  });

  it('scales with the grace constant', () => {
    const due = computeDueAt(sessionDate, toMinutes(10, 0));
    const expected = new Date(Date.UTC(2026, 2, 11, 10 + LOG_GRACE_HOURS, 0));
    expect(due.getTime()).toBe(expected.getTime());
  });
});

describe('compliance derivation', () => {
  const due = new Date('2026-03-12T04:00:00.000Z');

  it('is ON_TIME when filed before the deadline', () => {
    expect(deriveCompliance(new Date('2026-03-11T18:00:00Z'), due)).toBe('ON_TIME');
  });

  it('is ON_TIME when filed exactly at the deadline', () => {
    expect(deriveCompliance(due, due)).toBe('ON_TIME');
  });

  it('is LATE when filed after the deadline', () => {
    expect(deriveCompliance(new Date('2026-03-12T09:00:00Z'), due)).toBe('LATE');
  });

  it('is PENDING while the deadline has not passed', () => {
    expect(deriveCompliance(null, due, new Date('2026-03-11T20:00:00Z'))).toBe('PENDING');
  });

  it('is MISSING once the deadline passes with nothing filed', () => {
    expect(deriveCompliance(null, due, new Date('2026-03-12T05:00:00Z'))).toBe('MISSING');
  });
});
