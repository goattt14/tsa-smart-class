import { AttendanceSource, AttendanceStatus, Prisma, Role, SessionStatus } from '@prisma/client';
import { forbidden, notFound, unprocessable } from '../../lib/http-error';
import { prisma } from '../../lib/prisma';
import { studentVisibilityFilter } from '../../lib/scope';
import { toDateString, toUtcDate } from '../../lib/time';
import type { AuthContext } from '../../types/express';

/**
 * Loads a session the caller is allowed to mark, or explains why not.
 * Every write path goes through this, so the ownership rule lives in one place.
 */
async function loadMarkableSession(auth: AuthContext, sessionId: string) {
  const session = await prisma.classSession.findFirst({
    where: { id: sessionId, batch: { classGroup: { instituteId: auth.instituteId } } },
    select: {
      id: true,
      batchId: true,
      teacherId: true,
      status: true,
      sessionDate: true,
      startTimeMin: true,
      subject: { select: { name: true } },
    },
  });

  if (!session) throw notFound('Class session');

  if (auth.role === Role.TEACHER && session.teacherId !== auth.profileId) {
    throw forbidden('You can only mark attendance for your own lectures.');
  }

  if (session.status === SessionStatus.CANCELLED) {
    throw unprocessable('This class was cancelled, so attendance does not apply.');
  }

  return session;
}

export async function getSessionRoster(auth: AuthContext, sessionId: string) {
  const session = await loadMarkableSession(auth, sessionId);

  const enrollments = await prisma.enrollment.findMany({
    where: { batchId: session.batchId, status: 'ACTIVE' },
    orderBy: [{ rollNumber: 'asc' }],
    select: {
      rollNumber: true,
      student: {
        select: {
          id: true,
          admissionNumber: true,
          user: { select: { firstName: true, lastName: true, avatarUrl: true } },
        },
      },
    },
  });

  const marked = await prisma.attendance.findMany({
    where: { classSessionId: sessionId },
    select: {
      studentId: true,
      status: true,
      minutesLate: true,
      remarks: true,
      markedAt: true,
      source: true,
    },
  });

  const byStudent = new Map(marked.map((row) => [row.studentId, row]));

  return {
    sessionId,
    sessionDate: toDateString(session.sessionDate),
    subject: session.subject.name,
    alreadyMarked: marked.length > 0,
    roster: enrollments.map((row) => ({
      studentId: row.student.id,
      admissionNumber: row.student.admissionNumber,
      rollNumber: row.rollNumber,
      name: `${row.student.user.firstName} ${row.student.user.lastName}`,
      avatarUrl: row.student.user.avatarUrl,
      attendance: byStudent.get(row.student.id) ?? null,
    })),
  };
}

export interface MarkEntry {
  studentId: string;
  status: AttendanceStatus;
  minutesLate?: number | undefined;
  remarks?: string | undefined;
}

export interface MarkReport {
  sessionId: string;
  marked: number;
  updated: number;
  ignoredNotEnrolled: string[];
  counts: Record<AttendanceStatus, number>;
}

/**
 * Marks a whole class in one call.
 *
 * Upsert rather than insert, because a teacher correcting a mistake thirty
 * seconds later is the normal case, not an error. The full history stays
 * visible through the audit log rather than by refusing the second write.
 */
export async function markAttendance(
  auth: AuthContext,
  sessionId: string,
  entries: MarkEntry[],
  defaultRemainingToPresent: boolean,
): Promise<MarkReport> {
  const session = await loadMarkableSession(auth, sessionId);

  const enrolled = await prisma.enrollment.findMany({
    where: { batchId: session.batchId, status: 'ACTIVE' },
    select: { studentId: true },
  });

  const enrolledIds = new Set(enrolled.map((row) => row.studentId));
  const supplied = new Map(entries.map((entry) => [entry.studentId, entry]));

  const ignoredNotEnrolled = entries
    .filter((entry) => !enrolledIds.has(entry.studentId))
    .map((entry) => entry.studentId);

  const finalEntries: MarkEntry[] = entries.filter((entry) => enrolledIds.has(entry.studentId));

  if (defaultRemainingToPresent) {
    for (const studentId of enrolledIds) {
      if (!supplied.has(studentId)) {
        finalEntries.push({ studentId, status: AttendanceStatus.PRESENT });
      }
    }
  }

  if (finalEntries.length === 0) {
    throw unprocessable('No enrolled students were included in that request.');
  }

  const existing = await prisma.attendance.findMany({
    where: { classSessionId: sessionId, studentId: { in: finalEntries.map((e) => e.studentId) } },
    select: { studentId: true },
  });
  const existingIds = new Set(existing.map((row) => row.studentId));

  const source = auth.role === Role.TEACHER ? AttendanceSource.TEACHER : AttendanceSource.ADMIN;

  await prisma.$transaction(
    finalEntries.map((entry) =>
      prisma.attendance.upsert({
        where: {
          classSessionId_studentId: { classSessionId: sessionId, studentId: entry.studentId },
        },
        update: {
          status: entry.status,
          minutesLate: entry.status === AttendanceStatus.LATE ? (entry.minutesLate ?? null) : null,
          remarks: entry.remarks ?? null,
          markedById: auth.userId,
          markedAt: new Date(),
          source,
        },
        create: {
          classSessionId: sessionId,
          studentId: entry.studentId,
          status: entry.status,
          minutesLate: entry.status === AttendanceStatus.LATE ? (entry.minutesLate ?? null) : null,
          remarks: entry.remarks ?? null,
          markedById: auth.userId,
          source,
        },
      }),
    ),
  );

  // Marking attendance is the signal that the lecture actually happened.
  if (session.status === SessionStatus.SCHEDULED) {
    await prisma.classSession.update({
      where: { id: sessionId },
      data: { status: SessionStatus.COMPLETED, actualEndAt: new Date() },
    });
  }

  const counts: Record<AttendanceStatus, number> = {
    PRESENT: 0,
    ABSENT: 0,
    LATE: 0,
    EXCUSED: 0,
  };
  for (const entry of finalEntries) counts[entry.status] += 1;

  return {
    sessionId,
    marked: finalEntries.filter((e) => !existingIds.has(e.studentId)).length,
    updated: finalEntries.filter((e) => existingIds.has(e.studentId)).length,
    ignoredNotEnrolled,
    counts,
  };
}

export async function correctAttendance(
  auth: AuthContext,
  attendanceId: string,
  input: {
    status: AttendanceStatus;
    minutesLate?: number | null | undefined;
    remarks?: string | undefined;
  },
) {
  const existing = await prisma.attendance.findFirst({
    where: {
      id: attendanceId,
      classSession: { batch: { classGroup: { instituteId: auth.instituteId } } },
    },
    select: {
      id: true,
      status: true,
      minutesLate: true,
      remarks: true,
      studentId: true,
      classSession: { select: { id: true, teacherId: true } },
    },
  });

  if (!existing) throw notFound('Attendance record');

  if (auth.role === Role.TEACHER && existing.classSession.teacherId !== auth.profileId) {
    throw forbidden('You can only correct attendance for your own lectures.');
  }

  const after = await prisma.attendance.update({
    where: { id: attendanceId },
    data: {
      status: input.status,
      minutesLate: input.status === AttendanceStatus.LATE ? (input.minutesLate ?? null) : null,
      ...(input.remarks !== undefined ? { remarks: input.remarks } : {}),
      markedById: auth.userId,
      markedAt: new Date(),
    },
  });

  return { before: existing, after };
}

export interface AttendanceSummary {
  studentId: string;
  name: string;
  admissionNumber: string;
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  attendancePct: number;
}

/**
 * Per-student attendance across a window.
 *
 * The visibility filter is applied to the student list first, so a teacher sees
 * their batches, a parent sees their children, and a student sees only
 * themselves — without any of those cases needing a separate endpoint.
 */
export async function attendanceReport(
  auth: AuthContext,
  args: {
    from: string;
    to: string;
    batchId?: string | undefined;
    subjectId?: string | undefined;
    studentId?: string | undefined;
  },
): Promise<{ from: string; to: string; students: AttendanceSummary[] }> {
  if (args.to < args.from) throw unprocessable('The end date must fall on or after the start date.');

  const studentWhere: Prisma.StudentProfileWhereInput = {
    AND: [
      studentVisibilityFilter(auth),
      ...(args.studentId ? [{ id: args.studentId }] : []),
      ...(args.batchId
        ? [{ enrollments: { some: { batchId: args.batchId, status: 'ACTIVE' as const } } }]
        : []),
    ],
  };

  const students = await prisma.studentProfile.findMany({
    where: studentWhere,
    take: 500,
    select: {
      id: true,
      admissionNumber: true,
      user: { select: { firstName: true, lastName: true } },
    },
  });

  if (students.length === 0) return { from: args.from, to: args.to, students: [] };

  const rows = await prisma.attendance.groupBy({
    by: ['studentId', 'status'],
    where: {
      studentId: { in: students.map((s) => s.id) },
      classSession: {
        sessionDate: { gte: toUtcDate(args.from), lte: toUtcDate(args.to) },
        status: { not: SessionStatus.CANCELLED },
        ...(args.subjectId ? { subjectId: args.subjectId } : {}),
        ...(args.batchId ? { batchId: args.batchId } : {}),
      },
    },
    _count: { _all: true },
  });

  const tally = new Map<string, Record<AttendanceStatus, number>>();
  for (const student of students) {
    tally.set(student.id, { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 });
  }
  for (const row of rows) {
    const entry = tally.get(row.studentId);
    if (entry) entry[row.status] = row._count._all;
  }

  return {
    from: args.from,
    to: args.to,
    students: students.map((student) => {
      const counts = tally.get(student.id) ?? { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 };
      const total = counts.PRESENT + counts.ABSENT + counts.LATE + counts.EXCUSED;

      // Late still counts as attended. Excused is removed from the denominator
      // rather than counted against the student, which is what a parent would
      // consider fair for an authorised absence.
      const attended = counts.PRESENT + counts.LATE;
      const denominator = total - counts.EXCUSED;

      return {
        studentId: student.id,
        name: `${student.user.firstName} ${student.user.lastName}`,
        admissionNumber: student.admissionNumber,
        present: counts.PRESENT,
        absent: counts.ABSENT,
        late: counts.LATE,
        excused: counts.EXCUSED,
        total,
        attendancePct: denominator > 0 ? Math.round((attended / denominator) * 100) : 0,
      };
    }),
  };
}

/** Institute-wide daily percentage. No individual is identifiable, so management may read it. */
export async function attendanceTrend(auth: AuthContext, from: string, to: string) {
  const rows = await prisma.attendance.findMany({
    where: {
      classSession: {
        sessionDate: { gte: toUtcDate(from), lte: toUtcDate(to) },
        status: { not: SessionStatus.CANCELLED },
        batch: { classGroup: { instituteId: auth.instituteId } },
      },
    },
    select: { status: true, classSession: { select: { sessionDate: true } } },
  });

  const byDate = new Map<string, { attended: number; counted: number }>();

  for (const row of rows) {
    const key = toDateString(row.classSession.sessionDate);
    const entry = byDate.get(key) ?? { attended: 0, counted: 0 };
    if (row.status !== AttendanceStatus.EXCUSED) {
      entry.counted += 1;
      if (row.status !== AttendanceStatus.ABSENT) entry.attended += 1;
    }
    byDate.set(key, entry);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entry]) => ({
      date,
      attendancePct: entry.counted > 0 ? Math.round((entry.attended / entry.counted) * 100) : 0,
      records: entry.counted,
    }));
}
