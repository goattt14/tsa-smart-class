import { describe, expect, it } from 'vitest';
import { addDays, formatMinutes, toMinutes, weekdayOf } from '../lib/time';
import {
  buildTasks,
  isWithinStudyWindow,
  planSelfStudy,
  selectRule,
  summariseCompletion,
  type LectureContext,
  type SelfStudyPolicyConfig,
  type SelfStudyRuleConfig,
} from '../modules/selfstudy/selfstudy.engine';

const hm = toMinutes;

/** The policy exactly as the seed writes it. */
const policy: SelfStudyPolicyConfig = {
  defaultDurationMin: 120,
  taskCount: 2,
  focusMinPerTask: 45,
  evaluationMinPerTask: 15,
  newSessionCutoffMin: hm(21, 30),
  blackoutEndMin: hm(0, 30),
  minGapAfterClassMin: 60,
  reminderLeadMin: 15,
  allowWeekend: true,
};

/** The four rules exactly as the seed writes them. */
const rules: SelfStudyRuleConfig[] = [
  { id: 'r1', label: 'Afternoon lecture -> evening study', batchId: null, lectureStartMinFrom: hm(13, 0), lectureStartMinTo: hm(15, 59), selfStudyStartMin: hm(19, 0), durationMin: 120, dayOffset: 'SAME_DAY', priority: 10, isActive: true },
  { id: 'r2', label: 'Late-afternoon lecture -> later evening study', batchId: null, lectureStartMinFrom: hm(16, 0), lectureStartMinTo: hm(17, 59), selfStudyStartMin: hm(19, 30), durationMin: 120, dayOffset: 'SAME_DAY', priority: 20, isActive: true },
  { id: 'r3', label: 'Evening lecture -> next-day afternoon study', batchId: null, lectureStartMinFrom: hm(18, 0), lectureStartMinTo: hm(20, 59), selfStudyStartMin: hm(14, 0), durationMin: 120, dayOffset: 'NEXT_DAY', priority: 30, isActive: true },
  { id: 'r4', label: 'Morning lecture -> same-day evening study', batchId: null, lectureStartMinFrom: hm(7, 0), lectureStartMinTo: hm(12, 59), selfStudyStartMin: hm(19, 0), durationMin: 120, dayOffset: 'SAME_DAY', priority: 40, isActive: true },
];

// 2026-03-11 is a Wednesday.
function lecture(startH: number, endH: number, date = '2026-03-11'): LectureContext {
  return { classSessionId: 'cs-1', batchId: 'batch-A', sessionDate: date, startTimeMin: hm(startH), endTimeMin: hm(endH) };
}

function describePlan(plan: ReturnType<typeof planSelfStudy>): string {
  if (!plan.scheduled) return `SKIP:${plan.reason}`;
  return `${plan.studyDate} ${formatMinutes(plan.plannedStartMin)}-${formatMinutes(plan.plannedEndMin)}`;
}

describe('the timings stated in the brief', () => {
  it('turns a 2-4PM lecture into 7-9PM study the same day', () => {
    expect(describePlan(planSelfStudy(lecture(14, 16), rules, policy))).toBe('2026-03-11 19:00-21:00');
  });

  it('turns a 4-6PM lecture into 7:30-9:30PM study the same day', () => {
    expect(describePlan(planSelfStudy(lecture(16, 18), rules, policy))).toBe('2026-03-11 19:30-21:30');
  });

  it('turns a 6-8PM lecture into 2-4PM study the next day', () => {
    expect(describePlan(planSelfStudy(lecture(18, 20), rules, policy))).toBe('2026-03-12 14:00-16:00');
  });

  it('turns a morning lecture into evening study', () => {
    expect(describePlan(planSelfStudy(lecture(9, 11), rules, policy))).toBe('2026-03-11 19:00-21:00');
  });
});

describe('task breakdown', () => {
  const plan = planSelfStudy(lecture(14, 16), rules, policy);

  it('splits the block into two 45 + 15 tasks', () => {
    expect(plan.scheduled).toBe(true);
    if (!plan.scheduled) return;

    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0]).toMatchObject({ focusStartMin: hm(19, 0), focusEndMin: hm(19, 45), evaluationEndMin: hm(20, 0) });
    expect(plan.tasks[1]).toMatchObject({ focusStartMin: hm(20, 0), focusEndMin: hm(20, 45), evaluationEndMin: hm(21, 0) });
  });

  it('sets the reminder one lead time ahead', () => {
    expect(plan.scheduled && formatMinutes(plan.notifyAtMin)).toBe('18:45');
  });

  it('caps the task count at the policy value', () => {
    expect(buildTasks(hm(19, 0), 600, policy)).toHaveLength(2);
  });

  it('returns no task when the block is too short for one', () => {
    expect(buildTasks(hm(19, 0), 30, policy)).toHaveLength(0);
  });
});

describe('the 21:30 cutoff', () => {
  it('trims a block that would overrun rather than dropping it', () => {
    const trimRule = [{ ...rules[0]!, id: 'trim', selfStudyStartMin: hm(20, 0), lectureStartMinTo: hm(23, 59) }];
    const plan = planSelfStudy(lecture(14, 16), trimRule, policy);

    expect(describePlan(plan)).toBe('2026-03-11 20:00-21:00');
    expect(plan.scheduled && plan.adjustments.some((a) => a.includes('Shortened'))).toBe(true);
  });

  it('refuses a rule that can never fit, instead of retrying pointlessly', () => {
    const impossible = [{ ...rules[0]!, id: 'late', selfStudyStartMin: hm(20, 45), lectureStartMinTo: hm(23, 59) }];
    const plan = planSelfStudy(lecture(14, 16), impossible, policy);

    expect(plan.scheduled).toBe(false);
    expect(!plan.scheduled && plan.reason).toBe('NO_ROOM_IN_DAY');
    expect(!plan.scheduled && plan.detail).toContain('cannot be satisfied on any day');
  });

  it('refuses a rule starting after the cutoff outright', () => {
    const past = [{ ...rules[0]!, id: 'past', selfStudyStartMin: hm(22, 0), lectureStartMinTo: hm(23, 59) }];
    const plan = planSelfStudy(lecture(14, 16), past, policy);

    expect(!plan.scheduled && plan.reason).toBe('AFTER_DAILY_CUTOFF');
  });

  it('does roll to the next day when tonight alone is the problem', () => {
    // The lecture overruns to 20:30, so tonight is too tight, but the same rule
    // fits perfectly tomorrow.
    const overrun = { ...lecture(14, 16), endTimeMin: hm(20, 30) };
    const plan = planSelfStudy(overrun, rules, policy);

    expect(describePlan(plan)).toBe('2026-03-12 19:00-21:00');
    expect(plan.scheduled && plan.adjustments.some((a) => a.includes('next day'))).toBe(true);
  });
});

describe('breathing room and collisions', () => {
  it('keeps the configured gap after a lecture', () => {
    const plan = planSelfStudy({ ...lecture(16, 18), endTimeMin: hm(18, 30) }, rules, policy);
    expect(describePlan(plan)).toBe('2026-03-11 19:30-21:30');
  });

  it('steps around something already booked', () => {
    const busy = [{ date: '2026-03-11', startMin: hm(19, 0), endMin: hm(19, 30), label: 'Chemistry test' }];
    expect(describePlan(planSelfStudy(lecture(14, 16), rules, policy, busy))).toBe('2026-03-11 20:30-21:30');
  });
});

describe('weekends', () => {
  it('2026-03-13 is a Friday', () => {
    expect(weekdayOf('2026-03-13')).toBe('FRI');
  });

  it('schedules on Saturday when weekends are allowed', () => {
    expect(describePlan(planSelfStudy(lecture(18, 20, '2026-03-13'), rules, policy))).toBe('2026-03-14 14:00-16:00');
  });

  it('moves to Monday when weekends are switched off', () => {
    const plan = planSelfStudy(lecture(18, 20, '2026-03-13'), rules, { ...policy, allowWeekend: false });
    expect(describePlan(plan)).toBe('2026-03-16 14:00-16:00');
  });
});

describe('rule selection', () => {
  const withBatchRule: SelfStudyRuleConfig[] = [
    ...rules,
    { id: 'batch-specific', label: 'Batch A studies earlier', batchId: 'batch-A', lectureStartMinFrom: hm(13, 0), lectureStartMinTo: hm(15, 59), selfStudyStartMin: hm(18, 0), durationMin: 120, dayOffset: 'SAME_DAY', priority: 99, isActive: true },
  ];

  it('prefers a batch rule over a global one even at worse priority', () => {
    expect(selectRule(lecture(14, 16), withBatchRule)?.id).toBe('batch-specific');
  });

  it('ignores a rule belonging to another batch', () => {
    expect(selectRule({ ...lecture(14, 16), batchId: 'batch-B' }, withBatchRule)?.id).toBe('r1');
  });

  it('ignores inactive rules', () => {
    expect(selectRule(lecture(14, 16), [{ ...rules[0]!, isActive: false }])).toBeNull();
  });

  it('reports an uncovered lecture time clearly', () => {
    const plan = planSelfStudy(lecture(5, 6), rules, policy);
    expect(!plan.scheduled && plan.reason).toBe('NO_MATCHING_RULE');
  });
});

describe('policy validation', () => {
  it('refuses a policy with no tasks rather than scheduling nothing', () => {
    const plan = planSelfStudy(lecture(14, 16), rules, { ...policy, taskCount: 0 });
    expect(!plan.scheduled && plan.reason).toBe('INVALID_POLICY');
  });

  it('refuses a blackout that runs past the cutoff', () => {
    const plan = planSelfStudy(lecture(14, 16), rules, { ...policy, blackoutEndMin: hm(22, 0) });
    expect(!plan.scheduled && plan.reason).toBe('INVALID_POLICY');
  });
});

describe('a differently configured institute', () => {
  it('honours three tasks of 30 + 10 with a later cutoff', () => {
    const custom: SelfStudyPolicyConfig = { ...policy, taskCount: 3, focusMinPerTask: 30, evaluationMinPerTask: 10, newSessionCutoffMin: hm(22, 30) };
    const plan = planSelfStudy(lecture(14, 16), [{ ...rules[0]!, durationMin: 120 }], custom);

    expect(plan.scheduled && plan.tasks).toHaveLength(3);
    expect(describePlan(plan)).toBe('2026-03-11 19:00-21:00');
  });
});

describe('the live study window', () => {
  it.each([
    [hm(21, 31), false],
    [hm(21, 29), true],
    [hm(0, 15), false],
    [hm(0, 30), true],
    [hm(10, 0), true],
  ])('at %i minutes the window open state is %s', (minute, expected) => {
    expect(isWithinStudyWindow(minute, policy).allowed).toBe(expected);
  });

  it('explains itself when closed', () => {
    expect(isWithinStudyWindow(hm(22, 0), policy).reason).toContain('21:30');
  });
});

describe('completion', () => {
  it.each([
    [120, 120, 100, 'COMPLETED'],
    [120, 105, 88, 'COMPLETED'],
    [120, 60, 50, 'PARTIAL'],
    [120, 5, 4, 'MISSED'],
  ])('%i planned with %i active is %i%% and %s', (planned, active, pct, status) => {
    expect(summariseCompletion(planned, active)).toEqual({ completionPct: pct, status });
  });
});

describe('date arithmetic', () => {
  it.each([
    ['2026-02-28', '2026-03-01'],
    ['2028-02-28', '2028-02-29'],
    ['2026-12-31', '2027-01-01'],
  ])('%s plus a day is %s', (from, to) => {
    expect(addDays(from, 1)).toBe(to);
  });
});
