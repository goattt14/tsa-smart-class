/**
 * The self-study scheduling engine.
 *
 * Given a lecture that has just happened and the institute's configured rules,
 * this decides when the student sits down to study, for how long, and how that
 * block is divided into focus and evaluation.
 *
 * Every timing in here comes from a database row. Nothing is hardcoded: the
 * "2-4PM lecture becomes 7-9PM study" behaviour is a SelfStudyRule, the 21:30
 * cutoff is a SelfStudyPolicy column, and an institute that wants different
 * hours changes rows, not code.
 *
 * The module is deliberately free of Prisma, Express and every other import
 * except the time helpers. It is a pure function of its inputs, which is what
 * makes the scheduling rules testable without a database and reviewable by a
 * person who does not read TypeScript.
 */
import {
  addDays,
  formatMinutes,
  isWeekend,
  MINUTES_PER_DAY,
  overlaps,
  roundUpTo,
} from '../../lib/time';

export interface SelfStudyPolicyConfig {
  defaultDurationMin: number;
  taskCount: number;
  focusMinPerTask: number;
  evaluationMinPerTask: number;
  /** No new session may start after this. Default 1290 = 21:30. */
  newSessionCutoffMin: number;
  /** The blackout runs from the cutoff until this time next day. Default 30 = 00:30. */
  blackoutEndMin: number;
  minGapAfterClassMin: number;
  reminderLeadMin: number;
  allowWeekend: boolean;
}

export interface SelfStudyRuleConfig {
  id: string;
  label: string;
  /** null means the rule applies to every batch. */
  batchId: string | null;
  lectureStartMinFrom: number;
  lectureStartMinTo: number;
  selfStudyStartMin: number;
  durationMin: number;
  dayOffset: 'SAME_DAY' | 'NEXT_DAY';
  priority: number;
  isActive: boolean;
}

export interface LectureContext {
  classSessionId: string;
  batchId: string;
  /** YYYY-MM-DD */
  sessionDate: string;
  startTimeMin: number;
  endTimeMin: number;
}

/** Anything already occupying the student's day: other lectures, tests, a booked session. */
export interface BusyInterval {
  date: string;
  startMin: number;
  endMin: number;
  label: string;
}

export interface StudyTask {
  index: number;
  focusStartMin: number;
  focusEndMin: number;
  evaluationStartMin: number;
  evaluationEndMin: number;
}

export type SkipReason =
  | 'NO_MATCHING_RULE'
  | 'AFTER_DAILY_CUTOFF'
  | 'WEEKEND_DISABLED'
  | 'NO_ROOM_IN_DAY'
  | 'INVALID_POLICY';

export interface ScheduledPlan {
  scheduled: true;
  ruleId: string;
  ruleLabel: string;
  studyDate: string;
  plannedStartMin: number;
  plannedEndMin: number;
  durationMin: number;
  tasks: StudyTask[];
  notifyAtMin: number;
  /** Human-readable notes on anything the engine had to move. Shown in the UI. */
  adjustments: string[];
}

export interface SkippedPlan {
  scheduled: false;
  reason: SkipReason;
  detail: string;
  ruleId: string | null;
}

export type PlanResult = ScheduledPlan | SkippedPlan;

/** Study blocks land on quarter hours; a 19:07 start looks like a bug to a student. */
const ALIGNMENT_MIN = 15;
/** How many days forward the engine may push a session before giving up. */
const MAX_DAY_HOPS = 3;
/** Bound on the collision-avoidance loop, so a pathological day cannot spin. */
const MAX_COLLISION_SHIFTS = 12;

/**
 * Picks the rule that governs this lecture.
 *
 * Ties are broken deliberately: a rule written for one batch beats a global
 * rule, then explicit priority (lower wins), then the narrower time window,
 * because a rule covering 14:00-15:59 is a more specific statement about a
 * 14:00 lecture than one covering 07:00-20:59.
 */
export function selectRule(
  lecture: LectureContext,
  rules: SelfStudyRuleConfig[],
): SelfStudyRuleConfig | null {
  const matches = rules.filter(
    (rule) =>
      rule.isActive &&
      (rule.batchId === null || rule.batchId === lecture.batchId) &&
      lecture.startTimeMin >= rule.lectureStartMinFrom &&
      lecture.startTimeMin <= rule.lectureStartMinTo,
  );

  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    const aSpecific = a.batchId === null ? 1 : 0;
    const bSpecific = b.batchId === null ? 1 : 0;
    if (aSpecific !== bSpecific) return aSpecific - bSpecific;
    if (a.priority !== b.priority) return a.priority - b.priority;

    const aWidth = a.lectureStartMinTo - a.lectureStartMinFrom;
    const bWidth = b.lectureStartMinTo - b.lectureStartMinFrom;
    if (aWidth !== bWidth) return aWidth - bWidth;

    return a.id.localeCompare(b.id);
  });

  return matches[0] ?? null;
}

/**
 * Splits a block into `taskCount` tasks, each a focus stretch followed by an
 * evaluation stretch. With the default policy this is two tasks of 45 + 15,
 * filling two hours.
 */
export function buildTasks(
  startMin: number,
  durationMin: number,
  policy: SelfStudyPolicyConfig,
): StudyTask[] {
  const perTask = policy.focusMinPerTask + policy.evaluationMinPerTask;
  if (perTask <= 0) return [];

  const fits = Math.floor(durationMin / perTask);
  const count = Math.max(0, Math.min(policy.taskCount, fits));

  const tasks: StudyTask[] = [];
  let cursor = startMin;

  for (let index = 0; index < count; index += 1) {
    const focusStartMin = cursor;
    const focusEndMin = focusStartMin + policy.focusMinPerTask;
    const evaluationStartMin = focusEndMin;
    const evaluationEndMin = evaluationStartMin + policy.evaluationMinPerTask;

    tasks.push({ index: index + 1, focusStartMin, focusEndMin, evaluationStartMin, evaluationEndMin });
    cursor = evaluationEndMin;
  }

  return tasks;
}

/** The smallest block worth scheduling: one complete focus + evaluation cycle. */
function minimumViableMinutes(policy: SelfStudyPolicyConfig): number {
  return policy.focusMinPerTask + policy.evaluationMinPerTask;
}

function validatePolicy(policy: SelfStudyPolicyConfig): string | null {
  if (policy.focusMinPerTask <= 0) return 'focusMinPerTask must be greater than zero.';
  if (policy.evaluationMinPerTask < 0) return 'evaluationMinPerTask cannot be negative.';
  if (policy.taskCount <= 0) return 'taskCount must be at least one.';
  if (policy.newSessionCutoffMin <= 0 || policy.newSessionCutoffMin >= MINUTES_PER_DAY) {
    return 'newSessionCutoffMin must fall inside a single day.';
  }
  if (policy.blackoutEndMin < 0 || policy.blackoutEndMin >= policy.newSessionCutoffMin) {
    return 'blackoutEndMin must fall before newSessionCutoffMin.';
  }
  return null;
}

/**
 * Produces the study plan for one lecture.
 *
 * `busy` lists everything already occupying the student's calendar so the
 * engine can step around a second lecture or a scheduled test rather than
 * double-booking the evening.
 */
export function planSelfStudy(
  lecture: LectureContext,
  rules: SelfStudyRuleConfig[],
  policy: SelfStudyPolicyConfig,
  busy: BusyInterval[] = [],
): PlanResult {
  const policyProblem = validatePolicy(policy);
  if (policyProblem) {
    return { scheduled: false, reason: 'INVALID_POLICY', detail: policyProblem, ruleId: null };
  }

  const rule = selectRule(lecture, rules);
  if (!rule) {
    return {
      scheduled: false,
      reason: 'NO_MATCHING_RULE',
      detail: `No active rule covers a lecture starting at ${formatMinutes(lecture.startTimeMin)}.`,
      ruleId: null,
    };
  }

  const requestedDuration = rule.durationMin > 0 ? rule.durationMin : policy.defaultDurationMin;
  const firstDate =
    rule.dayOffset === 'NEXT_DAY' ? addDays(lecture.sessionDate, 1) : lecture.sessionDate;

  const adjustments: string[] = [];
  let attemptDate = firstDate;

  for (let hop = 0; hop <= MAX_DAY_HOPS; hop += 1) {
    if (hop > 0) {
      attemptDate = addDays(attemptDate, 1);
    }

    // --- weekend ------------------------------------------------------------
    if (!policy.allowWeekend && isWeekend(attemptDate)) {
      if (hop === MAX_DAY_HOPS) {
        return {
          scheduled: false,
          reason: 'WEEKEND_DISABLED',
          detail: 'Weekend study is switched off and no weekday was reachable.',
          ruleId: rule.id,
        };
      }
      adjustments.push(`${attemptDate} is a weekend and weekend study is off; moved on a day.`);
      continue;
    }

    let start = rule.selfStudyStartMin;
    const sameDayAsLecture = attemptDate === lecture.sessionDate;

    /**
     * Tracks whether anything about *this particular day* moved the start time.
     * It decides whether retrying tomorrow could possibly help. A lecture
     * overrunning, or a test already booked, is day-specific — tomorrow may
     * well be clear. A rule whose own start time cannot fit before the cutoff
     * will fail identically on every future day, so retrying would only burn
     * iterations and end in a vaguer error.
     */
    let movedByTodaysCalendar = false;

    // --- breathing room after the lecture -----------------------------------
    if (sameDayAsLecture) {
      const earliest = lecture.endTimeMin + policy.minGapAfterClassMin;
      if (start < earliest) {
        start = roundUpTo(earliest, ALIGNMENT_MIN);
        movedByTodaysCalendar = true;
        adjustments.push(
          `Moved to ${formatMinutes(start)} to leave ${policy.minGapAfterClassMin} minutes after class.`,
        );
      }
    }

    // --- never start inside the overnight blackout --------------------------
    if (start < policy.blackoutEndMin) {
      start = policy.blackoutEndMin;
      adjustments.push(`Pulled to ${formatMinutes(start)}, the end of the overnight blackout.`);
    }

    // --- step around anything already booked --------------------------------
    const dayBusy = busy
      .filter((slot) => slot.date === attemptDate)
      .sort((a, b) => a.startMin - b.startMin);

    let shifts = 0;
    let collided = true;

    while (collided && shifts < MAX_COLLISION_SHIFTS) {
      collided = false;
      for (const slot of dayBusy) {
        if (overlaps(start, start + requestedDuration, slot.startMin, slot.endMin)) {
          start = roundUpTo(slot.endMin + policy.minGapAfterClassMin, ALIGNMENT_MIN);
          movedByTodaysCalendar = true;
          adjustments.push(`Moved past ${slot.label} to ${formatMinutes(start)}.`);
          collided = true;
          shifts += 1;
          break;
        }
      }
    }

    // --- the cutoff ---------------------------------------------------------
    // A session may neither begin after the cutoff nor run past it into the
    // blackout, so the whole block has to land before 21:30 by default.
    if (start >= policy.newSessionCutoffMin) {
      if (!movedByTodaysCalendar) {
        return {
          scheduled: false,
          reason: 'AFTER_DAILY_CUTOFF',
          detail: `Rule "${rule.label}" starts study at ${formatMinutes(
            rule.selfStudyStartMin,
          )}, which is past the ${formatMinutes(
            policy.newSessionCutoffMin,
          )} cutoff on any day. Adjust the rule or the cutoff.`,
          ruleId: rule.id,
        };
      }

      if (hop === MAX_DAY_HOPS) {
        return {
          scheduled: false,
          reason: 'AFTER_DAILY_CUTOFF',
          detail: `The earliest free slot was ${formatMinutes(start)}, past the ${formatMinutes(
            policy.newSessionCutoffMin,
          )} cutoff.`,
          ruleId: rule.id,
        };
      }

      adjustments.push(
        `${formatMinutes(start)} is past the ${formatMinutes(
          policy.newSessionCutoffMin,
        )} cutoff; moved to the next day.`,
      );
      continue;
    }

    // --- trim to fit, or move on -------------------------------------------
    let duration = requestedDuration;
    const available = policy.newSessionCutoffMin - start;

    if (duration > available) {
      const unit = minimumViableMinutes(policy);
      const trimmed = Math.floor(available / unit) * unit;

      if (trimmed < unit) {
        if (!movedByTodaysCalendar) {
          return {
            scheduled: false,
            reason: 'NO_ROOM_IN_DAY',
            detail: `Rule "${rule.label}" starts study at ${formatMinutes(
              rule.selfStudyStartMin,
            )}, leaving ${available} minutes before the ${formatMinutes(
              policy.newSessionCutoffMin,
            )} cutoff. One task needs ${unit}. This rule cannot be satisfied on any day.`,
            ruleId: rule.id,
          };
        }

        if (hop === MAX_DAY_HOPS) {
          return {
            scheduled: false,
            reason: 'NO_ROOM_IN_DAY',
            detail: `Only ${available} minutes remained before the cutoff, short of the ${unit} needed for one task.`,
            ruleId: rule.id,
          };
        }

        adjustments.push(
          `Only ${available} minutes were left before the cutoff; moved to the next day.`,
        );
        continue;
      }

      duration = trimmed;
      adjustments.push(
        `Shortened to ${duration} minutes so the session ends by ${formatMinutes(
          policy.newSessionCutoffMin,
        )}.`,
      );
    }

    const tasks = buildTasks(start, duration, policy);

    if (tasks.length === 0) {
      return {
        scheduled: false,
        reason: 'NO_ROOM_IN_DAY',
        detail: 'The policy leaves no room for a single complete task.',
        ruleId: rule.id,
      };
    }

    const lastTask = tasks[tasks.length - 1] as StudyTask;
    const plannedEndMin = lastTask.evaluationEndMin;

    // The reminder must not fire inside the blackout either.
    const notifyAtMin = Math.max(policy.blackoutEndMin, start - policy.reminderLeadMin);

    return {
      scheduled: true,
      ruleId: rule.id,
      ruleLabel: rule.label,
      studyDate: attemptDate,
      plannedStartMin: start,
      plannedEndMin,
      durationMin: plannedEndMin - start,
      tasks,
      notifyAtMin,
      adjustments,
    };
  }

  return {
    scheduled: false,
    reason: 'NO_ROOM_IN_DAY',
    detail: 'No suitable slot was found within the search window.',
    ruleId: rule.id,
  };
}

/**
 * Answers "may a session begin right now?" for the live UI, which needs the
 * same cutoff logic without planning anything.
 */
export function isWithinStudyWindow(
  nowMin: number,
  policy: SelfStudyPolicyConfig,
): { allowed: boolean; reason?: string } {
  if (nowMin >= policy.newSessionCutoffMin) {
    return {
      allowed: false,
      reason: `New sessions stop at ${formatMinutes(
        policy.newSessionCutoffMin,
      )}. Rest tonight and pick this up tomorrow.`,
    };
  }

  if (nowMin < policy.blackoutEndMin) {
    return {
      allowed: false,
      reason: `Study opens at ${formatMinutes(policy.blackoutEndMin)}.`,
    };
  }

  return { allowed: true };
}

/**
 * Summarises how a plan compares with what the student actually did. Used by
 * the performance layer in a later phase and by the student's own timeline.
 */
export function summariseCompletion(
  plannedMinutes: number,
  activeMinutes: number,
): { completionPct: number; status: 'COMPLETED' | 'PARTIAL' | 'MISSED' } {
  if (plannedMinutes <= 0) return { completionPct: 0, status: 'MISSED' };

  const pct = Math.max(0, Math.min(100, Math.round((activeMinutes / plannedMinutes) * 100)));

  if (pct >= 85) return { completionPct: pct, status: 'COMPLETED' };
  if (pct >= 20) return { completionPct: pct, status: 'PARTIAL' };
  return { completionPct: pct, status: 'MISSED' };
}
