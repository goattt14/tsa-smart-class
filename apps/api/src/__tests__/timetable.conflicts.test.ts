import { describe, expect, it } from 'vitest';
import { toMinutes } from '../lib/time';
import {
  findConflicts,
  rangesOverlap,
  validateSlotTimes,
  weeklyLoadMinutes,
  type SlotShape,
} from '../modules/timetable/timetable.conflicts';

const hm = toMinutes;

function slot(overrides: Partial<SlotShape> = {}): SlotShape {
  return {
    id: 'existing-1',
    batchId: 'batch-A',
    subjectId: 'subject-phy',
    teacherId: 'teacher-1',
    weekday: 'MON',
    startTimeMin: hm(14, 0),
    endTimeMin: hm(16, 0),
    room: 'Room 201',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    isActive: true,
    ...overrides,
  };
}

describe('slot time validation', () => {
  it('accepts a normal two-hour lecture', () => {
    expect(validateSlotTimes(hm(14, 0), hm(16, 0))).toBeNull();
  });

  it.each([
    [hm(16, 0), hm(14, 0), 'end after it starts'],
    [hm(14, 0), hm(14, 0), 'end after it starts'],
    [hm(14, 0), hm(14, 10), 'at least 15 minutes'],
    [hm(8, 0), hm(14, 0), 'five hours'],
  ])('rejects %i to %i', (start, end, fragment) => {
    expect(validateSlotTimes(start, end)).toContain(fragment);
  });
});

describe('effective date ranges', () => {
  it('treats open-ended ranges as overlapping', () => {
    expect(rangesOverlap('2026-01-01', null, '2026-06-01', null)).toBe(true);
  });

  it('sees no overlap when one term ends before the other begins', () => {
    expect(rangesOverlap('2026-01-01', '2026-03-31', '2026-04-01', null)).toBe(false);
  });

  it('sees an overlap when the ranges touch', () => {
    expect(rangesOverlap('2026-01-01', '2026-04-01', '2026-04-01', null)).toBe(true);
  });
});

describe('conflict detection', () => {
  const existing = [slot()];

  it('finds no clash on a different weekday', () => {
    expect(findConflicts(slot({ id: 'new', weekday: 'TUE' }), existing)).toEqual([]);
  });

  it('finds no clash when the times do not overlap', () => {
    const candidate = slot({ id: 'new', startTimeMin: hm(16, 0), endTimeMin: hm(18, 0) });
    expect(findConflicts(candidate, existing)).toEqual([]);
  });

  it('catches a teacher double-booked', () => {
    const candidate = slot({ id: 'new', batchId: 'batch-B', room: 'Room 999', startTimeMin: hm(15, 0), endTimeMin: hm(17, 0) });
    const kinds = findConflicts(candidate, existing).map((c) => c.kind);
    expect(kinds).toEqual(['TEACHER']);
  });

  it('catches a batch double-booked', () => {
    const candidate = slot({ id: 'new', teacherId: 'teacher-2', room: 'Room 999', startTimeMin: hm(15, 0), endTimeMin: hm(17, 0) });
    expect(findConflicts(candidate, existing).map((c) => c.kind)).toEqual(['BATCH']);
  });

  it('catches a room double-booked', () => {
    const candidate = slot({ id: 'new', batchId: 'batch-B', teacherId: 'teacher-2', startTimeMin: hm(15, 0), endTimeMin: hm(17, 0) });
    expect(findConflicts(candidate, existing).map((c) => c.kind)).toEqual(['ROOM']);
  });

  it('reports all three at once rather than stopping at the first', () => {
    const candidate = slot({ id: 'new', startTimeMin: hm(15, 0), endTimeMin: hm(17, 0) });
    expect(findConflicts(candidate, existing).map((c) => c.kind).sort()).toEqual(['BATCH', 'ROOM', 'TEACHER']);
  });

  it('does not report a slot as clashing with itself', () => {
    expect(findConflicts(slot(), existing)).toEqual([]);
  });

  it('ignores inactive slots', () => {
    const candidate = slot({ id: 'new', startTimeMin: hm(15, 0), endTimeMin: hm(17, 0) });
    expect(findConflicts(candidate, [slot({ isActive: false })])).toEqual([]);
  });

  it('ignores a slot from a term that has already ended', () => {
    const candidate = slot({ id: 'new', effectiveFrom: '2026-05-01', startTimeMin: hm(15, 0), endTimeMin: hm(17, 0) });
    expect(findConflicts(candidate, [slot({ effectiveTo: '2026-04-30' })])).toEqual([]);
  });

  it('ignores a room clash when one slot has no room', () => {
    const candidate = slot({ id: 'new', batchId: 'batch-B', teacherId: 'teacher-2', room: null, startTimeMin: hm(15, 0), endTimeMin: hm(17, 0) });
    expect(findConflicts(candidate, existing)).toEqual([]);
  });

  it('explains the clash in the message', () => {
    const candidate = slot({ id: 'new', startTimeMin: hm(15, 0), endTimeMin: hm(17, 0) });
    expect(findConflicts(candidate, existing)[0]?.message).toContain('MON 15:00-17:00');
  });
});

describe('weekly load', () => {
  it('totals the minutes per weekday', () => {
    const load = weeklyLoadMinutes([
      slot(),
      slot({ id: 'b', weekday: 'MON', startTimeMin: hm(17, 0), endTimeMin: hm(18, 0) }),
      slot({ id: 'c', weekday: 'WED' }),
      slot({ id: 'd', weekday: 'WED', isActive: false }),
    ]);

    expect(load).toEqual({ MON: 180, WED: 120 });
  });
});
