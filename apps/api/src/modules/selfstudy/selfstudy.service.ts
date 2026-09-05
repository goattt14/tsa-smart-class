import { DayOffset, Prisma, Role, SelfStudyStatus, SessionStatus } from '@prisma/client';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/http-error';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { assertCanReadStudent, studentVisibilityFilter } from '../../lib/scope';
import { addDays, nowInZone, toDateString, toUtcDate } from '../../lib/time';
import type { AuthContext } from '../../types/express';
import {
  isWithinStudyWindow,
  planSelfStudy,
  summariseCompletion,
  type BusyInterval,
  type LectureContext,
  type PlanResult,
  type SelfStudyPolicyConfig,
  type SelfStudyRuleConfig,
} from './selfstudy.engine';

const DEFAULT_TZ = process.env.TZ ?? 'Asia/Kolkata';

/** Loads the institute's active policy and its rules in the engine's shape. */
export async function loadConfiguration(instituteId: string): Promise<{
  policyId: string;
  policy: SelfStudyPolicyConfig;
  rules: SelfStudyRuleConfig[];
}> {
  const policy = await prisma.selfStudyPolicy.findFirst({
    where: { instituteId, isActive: true },
    orderBy: { createdAt: 'asc' },
    include: { rules: { where: { isActive: true }, orderBy: { priority: 'asc' } } },
  });

  if (!policy) {
    throw unprocessable(
      'No active self-study policy exists for this institute. Run the seed or create one.',
    );
  }

  return {
    policyId: policy.id,
    policy: {
      defaultDurationMin: policy.defaultDurationMin,
      taskCount: policy.taskCount,
      focusMinPerTask: policy.focusMinPerTask,
      evaluationMinPerTask: policy.evaluationMinPerTask,
      newSessionCutoffMin: policy.newSessionCutoffMin,
      blackoutEndMin: policy.blackoutEndMin,
      minGapAfterClassMin: policy.minGapAfterClassMin,
      reminderLeadMin: policy.reminderLeadMin,
      allowWeekend: policy.allowWeekend,
    },
    rules: policy.rules.map((rule) => ({
      id: rule.id,
      label: rule.label,
      batchId: rule.batchId,
      lectureStartMinFrom: rule.lectureStartMinFrom,
      lectureStartMinTo: rule.lectureStartMinTo,
      selfStudyStartMin: rule.selfStudyStartMin,
      durationMin: rule.durationMin,
      dayOffset: rule.dayOffset,
      priority: rule.priority,
      isActive: rule.isActive,
    })),
  };
}

/**
 * Everything already occupying a student's day on the candidate dates: other
 * lectures, and self-study already booked. Passing these to the engine is what
 * stops a second lecture and the study block landing on top of each other.
 */
async function loadBusyIntervals(
  studentId: string,
  batchId: string,
  dates: string[],
): Promise<BusyInterval[]> {
  const from = toUtcDate(dates[0] ?? '');
  const to = toUtcDate(dates[dates.length - 1] ?? '');

  const [lectures, existing] = await Promise.all([
    prisma.classSession.findMany({
      where: {
        batchId,
        sessionDate: { gte: from, lte: to },
        status: { not: SessionStatus.CANCELLED },
      },
      select: {
        sessionDate: true,
        startTimeMin: true,
        endTimeMin: true,
        subject: { select: { name: true } },
      },
    }),
    prisma.selfStudySession.findMany({
      where: {
        studentId,
        studyDate: { gte: from, lte: to },
        status: { notIn: [SelfStudyStatus.MISSED, SelfStudyStatus.SKIPPED_BY_POLICY] },
      },
      select: { studyDate: true, plannedStartMin: true, plannedEndMin: true },
    }),
  ]);

  return [
    ...lectures.map((row) => ({
      date: toDateString(row.sessionDate),
      startMin: row.startTimeMin,
      endMin: row.endTimeMin,
      label: `${row.subject.name} class`,
    })),
    ...existing.map((row) => ({
      date: toDateString(row.studyDate),
      startMin: row.plannedStartMin,
      endMin: row.plannedEndMin,
      label: 'another study block',
    })),
  ];
}

export interface GenerationOutcome {
  classSessionId: string;
  planned: number;
  skipped: number;
  results: {
    studentId: string;
    studentName: string;
    plan: PlanResult;
    sessionId?: string;
  }[];
}

/**
 * Generates the self-study session for every student in the batch that just had
 * a lecture. This is the hinge of the whole product loop: class happens, and
 * the evening's work appears without anyone pressing anything.
 */
export async function generateForClassSession(
  auth: AuthContext,
  classSessionId: string,
  dryRun: boolean,
): Promise<GenerationOutcome> {
  const session = await prisma.classSession.findFirst({
    where: { id: classSessionId, batch: { classGroup: { instituteId: auth.instituteId } } },
    select: {
      id: true,
      batchId: true,
      teacherId: true,
      sessionDate: true,
      startTimeMin: true,
      endTimeMin: true,
      status: true,
    },
  });

  if (!session) throw notFound('Class session');

  if (auth.role === Role.TEACHER && session.teacherId !== auth.profileId) {
    throw forbidden('You can only generate study sessions for your own lectures.');
  }

  if (session.status === SessionStatus.CANCELLED) {
    throw unprocessable('That class was cancelled, so there is nothing to study from.');
  }

  const { policy, rules } = await loadConfiguration(auth.instituteId);

  const enrollments = await prisma.enrollment.findMany({
    where: { batchId: session.batchId, status: 'ACTIVE' },
    select: {
      student: {
        select: { id: true, user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  const lectureDate = toDateString(session.sessionDate);
  const lecture: LectureContext = {
    classSessionId: session.id,
    batchId: session.batchId,
    sessionDate: lectureDate,
    startTimeMin: session.startTimeMin,
    endTimeMin: session.endTimeMin,
  };

  const candidateDates = [lectureDate, addDays(lectureDate, 1), addDays(lectureDate, 2), addDays(lectureDate, 3), addDays(lectureDate, 4)];

  const outcome: GenerationOutcome = {
    classSessionId,
    planned: 0,
    skipped: 0,
    results: [],
  };

  for (const enrollment of enrollments) {
    const student = enrollment.student;
    const busy = await loadBusyIntervals(student.id, session.batchId, candidateDates);
    const plan = planSelfStudy(lecture, rules, policy, busy);
    const studentName = `${student.user.firstName} ${student.user.lastName}`;

    if (!plan.scheduled) {
      outcome.skipped += 1;
      outcome.results.push({ studentId: student.id, studentName, plan });
      continue;
    }

    if (dryRun) {
      outcome.planned += 1;
      outcome.results.push({ studentId: student.id, studentName, plan });
      continue;
    }

    // The unique key on (studentId, studyDate, plannedStartMin) makes a repeat
    // run harmless, which matters because the cron job and a teacher pressing
    // "generate" can easily both fire for the same lecture.
    const created = await prisma.selfStudySession
      .upsert({
        where: {
          studentId_studyDate_plannedStartMin: {
            studentId: student.id,
            studyDate: toUtcDate(plan.studyDate),
            plannedStartMin: plan.plannedStartMin,
          },
        },
        update: {},
        create: {
          studentId: student.id,
          ruleId: plan.ruleId,
          classSessionId: session.id,
          studyDate: toUtcDate(plan.studyDate),
          plannedStartMin: plan.plannedStartMin,
          plannedEndMin: plan.plannedEndMin,
          durationMin: plan.durationMin,
        },
        select: { id: true },
      })
      .catch((error: unknown) => {
        logger.error({ err: error, studentId: student.id }, 'failed to write self-study session');
        return null;
      });

    if (created) {
      outcome.planned += 1;
      outcome.results.push({ studentId: student.id, studentName, plan, sessionId: created.id });
    } else {
      outcome.skipped += 1;
      outcome.results.push({ studentId: student.id, studentName, plan });
    }
  }

  return outcome;
}

export async function listSessions(
  auth: AuthContext,
  args: {
    from?: string | undefined;
    to?: string | undefined;
    studentId?: string | undefined;
    status?: SelfStudyStatus | undefined;
    limit: number;
  },
) {
  const where: Prisma.SelfStudySessionWhereInput = {
    student: studentVisibilityFilter(auth),
    ...(args.studentId ? { studentId: args.studentId } : {}),
    ...(args.status ? { status: args.status } : {}),
    ...(args.from || args.to
      ? {
          studyDate: {
            ...(args.from ? { gte: toUtcDate(args.from) } : {}),
            ...(args.to ? { lte: toUtcDate(args.to) } : {}),
          },
        }
      : {}),
  };

  return prisma.selfStudySession.findMany({
    where,
    orderBy: [{ studyDate: 'asc' }, { plannedStartMin: 'asc' }],
    take: args.limit,
    select: {
      id: true,
      studyDate: true,
      plannedStartMin: true,
      plannedEndMin: true,
      durationMin: true,
      status: true,
      startedAt: true,
      completedAt: true,
      activeMinutes: true,
      completionPct: true,
      skipReason: true,
      rule: { select: { id: true, label: true } },
      classSession: {
        select: {
          id: true,
          sessionDate: true,
          subject: { select: { name: true, colorHex: true } },
        },
      },
      student: {
        select: { id: true, user: { select: { firstName: true, lastName: true } } },
      },
    },
  });
}

/** The student's own view: today's plan plus whether the window is open. */
export async function todayForStudent(auth: AuthContext, studentId: string) {
  await assertCanReadStudent(auth, studentId);

  const { policy } = await loadConfiguration(auth.instituteId);
  const { date, minutes } = nowInZone(DEFAULT_TZ);

  const sessions = await prisma.selfStudySession.findMany({
    where: { studentId, studyDate: toUtcDate(date) },
    orderBy: { plannedStartMin: 'asc' },
    select: {
      id: true,
      plannedStartMin: true,
      plannedEndMin: true,
      durationMin: true,
      status: true,
      activeMinutes: true,
      completionPct: true,
      rule: { select: { label: true } },
      classSession: { select: { subject: { select: { name: true, colorHex: true } } } },
    },
  });

  const window = isWithinStudyWindow(minutes, policy);

  return {
    date,
    nowMinutes: minutes,
    windowOpen: window.allowed,
    windowMessage: window.reason ?? null,
    cutoffMin: policy.newSessionCutoffMin,
    blackoutEndMin: policy.blackoutEndMin,
    taskShape: {
      taskCount: policy.taskCount,
      focusMinPerTask: policy.focusMinPerTask,
      evaluationMinPerTask: policy.evaluationMinPerTask,
    },
    sessions,
  };
}

async function loadOwnSession(auth: AuthContext, sessionId: string) {
  const session = await prisma.selfStudySession.findFirst({
    where: { id: sessionId, student: studentVisibilityFilter(auth) },
    select: {
      id: true,
      studentId: true,
      status: true,
      studyDate: true,
      plannedStartMin: true,
      plannedEndMin: true,
      durationMin: true,
      activeMinutes: true,
      startedAt: true,
    },
  });

  if (!session) throw notFound('Self-study session');

  if (auth.role === Role.STUDENT && session.studentId !== auth.profileId) {
    throw forbidden('That is not your study session.');
  }

  return session;
}

export async function startSession(auth: AuthContext, sessionId: string) {
  const session = await loadOwnSession(auth, sessionId);

  if (session.status === SelfStudyStatus.COMPLETED) {
    throw conflict('That session is already finished.');
  }
  if (session.status === SelfStudyStatus.IN_PROGRESS) {
    return prisma.selfStudySession.findUniqueOrThrow({ where: { id: sessionId } });
  }

  const { policy } = await loadConfiguration(auth.instituteId);
  const { minutes } = nowInZone(DEFAULT_TZ);

  // The same cutoff the planner honours is enforced again here, because a
  // student can always leave a tab open until 22:00 and press start.
  const window = isWithinStudyWindow(minutes, policy);
  if (!window.allowed) {
    throw unprocessable(window.reason ?? 'Study is closed right now.');
  }

  return prisma.selfStudySession.update({
    where: { id: sessionId },
    data: { status: SelfStudyStatus.IN_PROGRESS, startedAt: session.startedAt ?? new Date() },
  });
}

export async function completeSession(
  auth: AuthContext,
  sessionId: string,
  activeMinutes: number | undefined,
) {
  const session = await loadOwnSession(auth, sessionId);

  const minutes = activeMinutes ?? session.activeMinutes;
  const { completionPct, status } = summariseCompletion(session.durationMin, minutes);

  return prisma.selfStudySession.update({
    where: { id: sessionId },
    data: {
      status:
        status === 'COMPLETED'
          ? SelfStudyStatus.COMPLETED
          : status === 'PARTIAL'
            ? SelfStudyStatus.PARTIAL
            : SelfStudyStatus.MISSED,
      completedAt: new Date(),
      activeMinutes: minutes,
      completionPct,
    },
  });
}

export async function recordHeartbeat(
  auth: AuthContext,
  sessionId: string,
  activeMinutes: number,
) {
  const session = await loadOwnSession(auth, sessionId);

  // Monotonic: a refreshed tab reporting a lower figure must not erase progress.
  const minutes = Math.max(session.activeMinutes, activeMinutes);

  return prisma.selfStudySession.update({
    where: { id: sessionId },
    data: {
      activeMinutes: minutes,
      completionPct: summariseCompletion(session.durationMin, minutes).completionPct,
    },
    select: { id: true, activeMinutes: true, completionPct: true, status: true },
  });
}

export async function skipSession(auth: AuthContext, sessionId: string, reason: string) {
  const session = await loadOwnSession(auth, sessionId);

  if (session.status === SelfStudyStatus.COMPLETED) {
    throw conflict('That session is already finished.');
  }

  return prisma.selfStudySession.update({
    where: { id: sessionId },
    data: { status: SelfStudyStatus.SKIPPED_BY_POLICY, skipReason: reason },
  });
}

/**
 * Closes out sessions whose day has passed without being finished. Run nightly
 * after the blackout begins, so a student studying at 21:29 is not marked
 * missed at 21:30.
 */
export async function sweepMissedSessions(beforeDate: string): Promise<number> {
  const result = await prisma.selfStudySession.updateMany({
    where: {
      studyDate: { lt: toUtcDate(beforeDate) },
      status: { in: [SelfStudyStatus.SCHEDULED, SelfStudyStatus.NOTIFIED, SelfStudyStatus.IN_PROGRESS] },
    },
    data: { status: SelfStudyStatus.MISSED },
  });

  return result.count;
}

// --------------------------------------------------------------- policy -----

export async function getPolicy(auth: AuthContext) {
  const policy = await prisma.selfStudyPolicy.findFirst({
    where: { instituteId: auth.instituteId },
    orderBy: { createdAt: 'asc' },
    include: { rules: { orderBy: [{ priority: 'asc' }, { lectureStartMinFrom: 'asc' }] } },
  });

  if (!policy) throw notFound('Self-study policy');
  return policy;
}

export async function updatePolicy(
  auth: AuthContext,
  input: Record<string, unknown>,
) {
  const existing = await prisma.selfStudyPolicy.findFirst({
    where: { instituteId: auth.instituteId },
    orderBy: { createdAt: 'asc' },
  });

  if (!existing) throw notFound('Self-study policy');

  const merged = { ...existing, ...input } as typeof existing;

  if (merged.blackoutEndMin >= merged.newSessionCutoffMin) {
    throw unprocessable('The blackout must end before the daily cutoff.');
  }

  const perTask = merged.focusMinPerTask + merged.evaluationMinPerTask;
  if (perTask * merged.taskCount > merged.defaultDurationMin) {
    throw unprocessable(
      `${merged.taskCount} tasks of ${perTask} minutes need ${perTask * merged.taskCount} minutes, more than the ${merged.defaultDurationMin}-minute default block.`,
    );
  }

  const after = await prisma.selfStudyPolicy.update({
    where: { id: existing.id },
    data: input as Prisma.SelfStudyPolicyUpdateInput,
  });

  return { before: existing, after };
}

export async function createRule(
  auth: AuthContext,
  input: {
    label: string;
    batchId?: string | null | undefined;
    lectureStartMinFrom: number;
    lectureStartMinTo: number;
    selfStudyStartMin: number;
    durationMin: number;
    dayOffset: 'SAME_DAY' | 'NEXT_DAY';
    priority: number;
  },
) {
  const policy = await prisma.selfStudyPolicy.findFirst({
    where: { instituteId: auth.instituteId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, newSessionCutoffMin: true, focusMinPerTask: true, evaluationMinPerTask: true },
  });

  if (!policy) throw notFound('Self-study policy');

  if (input.lectureStartMinTo < input.lectureStartMinFrom) {
    throw unprocessable('The lecture window must end after it starts.');
  }

  // Refuse a rule the engine could never satisfy, rather than letting it fail
  // silently for every student every evening.
  const minimum = policy.focusMinPerTask + policy.evaluationMinPerTask;
  if (input.selfStudyStartMin + minimum > policy.newSessionCutoffMin) {
    throw unprocessable(
      `A study block starting at that time leaves less than the ${minimum} minutes one task needs before the daily cutoff.`,
    );
  }

  if (input.batchId) {
    const batch = await prisma.batch.findFirst({
      where: { id: input.batchId, classGroup: { instituteId: auth.instituteId } },
      select: { id: true },
    });
    if (!batch) throw notFound('Batch');
  }

  return prisma.selfStudyRule.create({
    data: {
      policyId: policy.id,
      label: input.label,
      batchId: input.batchId ?? null,
      lectureStartMinFrom: input.lectureStartMinFrom,
      lectureStartMinTo: input.lectureStartMinTo,
      selfStudyStartMin: input.selfStudyStartMin,
      durationMin: input.durationMin,
      dayOffset: input.dayOffset === 'NEXT_DAY' ? DayOffset.NEXT_DAY : DayOffset.SAME_DAY,
      priority: input.priority,
    },
  });
}

export async function updateRule(
  auth: AuthContext,
  ruleId: string,
  input: Record<string, unknown>,
) {
  const existing = await prisma.selfStudyRule.findFirst({
    where: { id: ruleId, policy: { instituteId: auth.instituteId } },
  });

  if (!existing) throw notFound('Self-study rule');

  const after = await prisma.selfStudyRule.update({
    where: { id: ruleId },
    data: input as Prisma.SelfStudyRuleUpdateInput,
  });

  return { before: existing, after };
}

export async function deleteRule(auth: AuthContext, ruleId: string) {
  const existing = await prisma.selfStudyRule.findFirst({
    where: { id: ruleId, policy: { instituteId: auth.instituteId } },
    select: { id: true, label: true },
  });

  if (!existing) throw notFound('Self-study rule');

  await prisma.selfStudyRule.update({ where: { id: ruleId }, data: { isActive: false } });
  return existing;
}
