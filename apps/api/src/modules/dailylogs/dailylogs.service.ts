import { ComplianceStatus, Prisma, Role, SessionStatus } from '@prisma/client';
import { forbidden, notFound, unprocessable } from '../../lib/http-error';
import { prisma } from '../../lib/prisma';
import { toDateString, toUtcDate } from '../../lib/time';
import type { AuthContext } from '../../types/express';

/**
 * How long after a lecture a teacher has to file the log before it counts late.
 * Kept here rather than in the database because it is a property of the
 * compliance rule, not of any one institute's timetable; if that changes it
 * becomes a SystemSetting row.
 */
export const LOG_GRACE_HOURS = 12;

/** A lecture ending at 16:00 gives a deadline of 04:00 the next morning. */
export function computeDueAt(sessionDate: Date, endTimeMin: number): Date {
  const due = new Date(sessionDate.getTime());
  due.setUTCMinutes(due.getUTCMinutes() + endTimeMin + LOG_GRACE_HOURS * 60);
  return due;
}

/**
 * Compliance is derived, never stored by hand.
 *
 * PENDING  the lecture happened, the deadline has not passed, nothing filed
 * ON_TIME  filed before the deadline
 * LATE     filed after the deadline
 * MISSING  deadline passed with nothing filed
 */
export function deriveCompliance(
  submittedAt: Date | null,
  dueAt: Date,
  now: Date = new Date(),
): ComplianceStatus {
  if (submittedAt) {
    return submittedAt <= dueAt ? ComplianceStatus.ON_TIME : ComplianceStatus.LATE;
  }
  return now <= dueAt ? ComplianceStatus.PENDING : ComplianceStatus.MISSING;
}

export async function submitLog(
  auth: AuthContext,
  sessionId: string,
  input: {
    topic: string;
    description: string;
    notes?: string | undefined;
    keyPoints: string[];
    homeworkGiven?: string | undefined;
  },
) {
  const session = await prisma.classSession.findFirst({
    where: { id: sessionId, batch: { classGroup: { instituteId: auth.instituteId } } },
    select: {
      id: true,
      teacherId: true,
      status: true,
      sessionDate: true,
      endTimeMin: true,
      subject: { select: { name: true } },
      batch: { select: { name: true } },
      dailyLog: { select: { id: true, submittedAt: true, compliance: true } },
    },
  });

  if (!session) throw notFound('Class session');

  if (auth.role === Role.TEACHER && session.teacherId !== auth.profileId) {
    throw forbidden('You can only file a log for your own lecture.');
  }

  if (session.status === SessionStatus.CANCELLED) {
    throw unprocessable('This class was cancelled, so there is nothing to log.');
  }

  const dueAt = computeDueAt(session.sessionDate, session.endTimeMin);
  const now = new Date();

  // The first submission fixes the compliance verdict. A later edit corrects
  // the content but must not launder a late filing into an on-time one.
  const submittedAt = session.dailyLog?.submittedAt ?? now;
  const compliance = deriveCompliance(submittedAt, dueAt, now);

  const log = await prisma.teacherDailyLog.upsert({
    where: { classSessionId: sessionId },
    update: {
      topic: input.topic,
      description: input.description,
      notes: input.notes || null,
      keyPoints: input.keyPoints,
      homeworkGiven: input.homeworkGiven || null,
    },
    create: {
      classSessionId: sessionId,
      teacherId: session.teacherId,
      topic: input.topic,
      description: input.description,
      notes: input.notes || null,
      keyPoints: input.keyPoints,
      homeworkGiven: input.homeworkGiven || null,
      dueAt,
      submittedAt,
      compliance,
    },
    select: {
      id: true,
      topic: true,
      compliance: true,
      submittedAt: true,
      dueAt: true,
    },
  });

  return { log, wasEdit: Boolean(session.dailyLog) };
}

export async function listLogs(
  auth: AuthContext,
  args: {
    from?: string | undefined;
    to?: string | undefined;
    teacherId?: string | undefined;
    batchId?: string | undefined;
    compliance?: ComplianceStatus | undefined;
    limit: number;
  },
) {
  const where: Prisma.TeacherDailyLogWhereInput = {
    classSession: {
      batch: {
        classGroup: { instituteId: auth.instituteId },
        ...(args.batchId ? { id: args.batchId } : {}),
      },
      ...(args.from || args.to
        ? {
            sessionDate: {
              ...(args.from ? { gte: toUtcDate(args.from) } : {}),
              ...(args.to ? { lte: toUtcDate(args.to) } : {}),
            },
          }
        : {}),
    },
    ...(args.compliance ? { compliance: args.compliance } : {}),
  };

  if (args.teacherId) {
    where.teacherId = args.teacherId;
  } else if (auth.role === Role.TEACHER && auth.profileId) {
    where.teacherId = auth.profileId;
  }

  return prisma.teacherDailyLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: args.limit,
    select: {
      id: true,
      topic: true,
      description: true,
      keyPoints: true,
      homeworkGiven: true,
      compliance: true,
      dueAt: true,
      submittedAt: true,
      teacher: {
        select: { id: true, user: { select: { firstName: true, lastName: true } } },
      },
      classSession: {
        select: {
          id: true,
          sessionDate: true,
          startTimeMin: true,
          subject: { select: { name: true, colorHex: true } },
          batch: { select: { name: true } },
        },
      },
    },
  });
}

/** Lectures the caller has taught that still have no log filed. */
export async function outstandingForTeacher(auth: AuthContext, teacherId: string) {
  const sessions = await prisma.classSession.findMany({
    where: {
      teacherId,
      status: { in: [SessionStatus.COMPLETED, SessionStatus.ONGOING] },
      dailyLog: { is: null },
      batch: { classGroup: { instituteId: auth.instituteId } },
    },
    orderBy: { sessionDate: 'desc' },
    take: 60,
    select: {
      id: true,
      sessionDate: true,
      startTimeMin: true,
      endTimeMin: true,
      subject: { select: { name: true } },
      batch: { select: { name: true } },
    },
  });

  const now = new Date();

  return sessions.map((session) => {
    const dueAt = computeDueAt(session.sessionDate, session.endTimeMin);
    return {
      classSessionId: session.id,
      sessionDate: toDateString(session.sessionDate),
      startTimeMin: session.startTimeMin,
      subject: session.subject.name,
      batch: session.batch.name,
      dueAt,
      status: deriveCompliance(null, dueAt, now),
    };
  });
}

export interface TeacherCompliance {
  teacherId: string;
  name: string;
  employeeCode: string;
  lecturesHeld: number;
  onTime: number;
  late: number;
  pending: number;
  missing: number;
  compliancePct: number;
}

/**
 * Compliance across every teacher for a window.
 *
 * This is the report management is meant to read: it names teachers, who are
 * staff, and contains no student data at all, which is why it sits behind
 * `dailylog.compliance` rather than a sensitive key.
 */
export async function complianceReport(
  auth: AuthContext,
  args: { from: string; to: string; teacherId?: string | undefined },
): Promise<{ from: string; to: string; teachers: TeacherCompliance[] }> {
  if (args.to < args.from) throw unprocessable('The end date must fall on or after the start date.');

  const teachers = await prisma.teacherProfile.findMany({
    where: {
      deletedAt: null,
      user: { instituteId: auth.instituteId, deletedAt: null },
      ...(args.teacherId ? { id: args.teacherId } : {}),
    },
    select: {
      id: true,
      employeeCode: true,
      user: { select: { firstName: true, lastName: true } },
    },
  });

  if (teachers.length === 0) return { from: args.from, to: args.to, teachers: [] };

  const sessions = await prisma.classSession.findMany({
    where: {
      teacherId: { in: teachers.map((t) => t.id) },
      sessionDate: { gte: toUtcDate(args.from), lte: toUtcDate(args.to) },
      status: { not: SessionStatus.CANCELLED },
    },
    select: {
      teacherId: true,
      sessionDate: true,
      endTimeMin: true,
      dailyLog: { select: { submittedAt: true } },
    },
  });

  const now = new Date();
  const tally = new Map<string, { onTime: number; late: number; pending: number; missing: number }>();

  for (const teacher of teachers) {
    tally.set(teacher.id, { onTime: 0, late: 0, pending: 0, missing: 0 });
  }

  for (const session of sessions) {
    const entry = tally.get(session.teacherId);
    if (!entry) continue;

    // Recomputed from timestamps rather than read from the stored column, so a
    // stale row cannot flatter anybody's numbers.
    const dueAt = computeDueAt(session.sessionDate, session.endTimeMin);
    const status = deriveCompliance(session.dailyLog?.submittedAt ?? null, dueAt, now);

    if (status === ComplianceStatus.ON_TIME) entry.onTime += 1;
    else if (status === ComplianceStatus.LATE) entry.late += 1;
    else if (status === ComplianceStatus.PENDING) entry.pending += 1;
    else entry.missing += 1;
  }

  return {
    from: args.from,
    to: args.to,
    teachers: teachers
      .map((teacher) => {
        const counts = tally.get(teacher.id) ?? { onTime: 0, late: 0, pending: 0, missing: 0 };
        const held = counts.onTime + counts.late + counts.pending + counts.missing;

        // Pending is excluded: a lecture whose deadline has not passed is not
        // yet a failure, and counting it as one would punish a teacher for the
        // report being run early in the day.
        const settled = counts.onTime + counts.late + counts.missing;

        return {
          teacherId: teacher.id,
          name: `${teacher.user.firstName} ${teacher.user.lastName}`,
          employeeCode: teacher.employeeCode,
          lecturesHeld: held,
          onTime: counts.onTime,
          late: counts.late,
          pending: counts.pending,
          missing: counts.missing,
          compliancePct: settled > 0 ? Math.round((counts.onTime / settled) * 100) : 100,
        };
      })
      .sort((a, b) => a.compliancePct - b.compliancePct),
  };
}

/**
 * Moves logs whose deadline has passed from PENDING to MISSING. Run nightly.
 * Without this the stored column drifts and every dashboard reading it lies.
 */
export async function sweepOverdueLogs(): Promise<number> {
  const result = await prisma.teacherDailyLog.updateMany({
    where: {
      compliance: ComplianceStatus.PENDING,
      submittedAt: null,
      dueAt: { lt: new Date() },
    },
    data: { compliance: ComplianceStatus.MISSING },
  });

  return result.count;
}
