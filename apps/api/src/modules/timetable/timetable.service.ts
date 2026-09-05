import { Prisma, Role, SessionStatus, Weekday } from '@prisma/client';
import { conflict, notFound, unprocessable } from '../../lib/http-error';
import { prisma } from '../../lib/prisma';
import { batchVisibilityFilter } from '../../lib/scope';
import { addDays, dateRange, toDateString, toUtcDate, weekdayOf } from '../../lib/time';
import type { AuthContext } from '../../types/express';
import { findConflicts, validateSlotTimes, type SlotShape } from './timetable.conflicts';

/** Prisma returns @db.Date as a UTC-midnight Date; the engine wants a string. */
function dateOnly(value: Date | null): string | null {
  return value ? toDateString(value) : null;
}

const slotSelect = {
  id: true,
  batchId: true,
  subjectId: true,
  teacherId: true,
  weekday: true,
  startTimeMin: true,
  endTimeMin: true,
  room: true,
  effectiveFrom: true,
  effectiveTo: true,
  isActive: true,
} satisfies Prisma.TimetableSlotSelect;

type SlotRow = Prisma.TimetableSlotGetPayload<{ select: typeof slotSelect }>;

function toShape(row: SlotRow): SlotShape {
  return {
    id: row.id,
    batchId: row.batchId,
    subjectId: row.subjectId,
    teacherId: row.teacherId,
    weekday: row.weekday,
    startTimeMin: row.startTimeMin,
    endTimeMin: row.endTimeMin,
    room: row.room,
    effectiveFrom: toDateString(row.effectiveFrom),
    effectiveTo: dateOnly(row.effectiveTo),
    isActive: row.isActive,
  };
}

export async function listSlots(
  auth: AuthContext,
  args: {
    batchId?: string | undefined;
    teacherId?: string | undefined;
    subjectId?: string | undefined;
    weekday?: Weekday | undefined;
    includeInactive: boolean;
  },
) {
  const where: Prisma.TimetableSlotWhereInput = {
    batch: batchVisibilityFilter(auth),
    ...(args.batchId ? { batchId: args.batchId } : {}),
    ...(args.subjectId ? { subjectId: args.subjectId } : {}),
    ...(args.weekday ? { weekday: args.weekday } : {}),
    ...(args.includeInactive ? {} : { isActive: true }),
  };

  // A teacher asking for "my timetable" is the common case, so it is the
  // default rather than something they have to pass an id for.
  if (args.teacherId) {
    where.teacherId = args.teacherId;
  } else if (auth.role === Role.TEACHER && auth.profileId) {
    where.teacherId = auth.profileId;
  }

  return prisma.timetableSlot.findMany({
    where,
    orderBy: [{ weekday: 'asc' }, { startTimeMin: 'asc' }],
    select: {
      ...slotSelect,
      batch: { select: { id: true, name: true, code: true } },
      subject: { select: { id: true, name: true, code: true, colorHex: true } },
      teacher: {
        select: { id: true, user: { select: { firstName: true, lastName: true } } },
      },
    },
  });
}

interface SlotInput {
  batchId: string;
  subjectId: string;
  teacherId: string;
  weekday: Weekday;
  startTimeMin: number;
  endTimeMin: number;
  room?: string | undefined;
  effectiveFrom: string;
  effectiveTo?: string | null | undefined;
}

async function assertOwnership(auth: AuthContext, input: Partial<SlotInput>): Promise<void> {
  if (input.batchId) {
    const batch = await prisma.batch.findFirst({
      where: { id: input.batchId, classGroup: { instituteId: auth.instituteId }, deletedAt: null },
      select: { id: true },
    });
    if (!batch) throw notFound('Batch');
  }

  if (input.subjectId) {
    const subject = await prisma.subject.findFirst({
      where: { id: input.subjectId, instituteId: auth.instituteId, deletedAt: null },
      select: { id: true },
    });
    if (!subject) throw notFound('Subject');
  }

  if (input.teacherId) {
    const teacher = await prisma.teacherProfile.findFirst({
      where: { id: input.teacherId, user: { instituteId: auth.instituteId, deletedAt: null } },
      select: { id: true },
    });
    if (!teacher) throw notFound('Teacher');
  }
}

/**
 * Loads the slots a candidate could possibly clash with. Narrowing by weekday
 * and institute keeps this to a handful of rows even for a large timetable.
 */
async function loadPotentialClashes(
  auth: AuthContext,
  weekday: Weekday,
  batchId: string,
  teacherId: string,
  room: string | null,
): Promise<SlotShape[]> {
  const rows = await prisma.timetableSlot.findMany({
    where: {
      weekday,
      isActive: true,
      batch: { classGroup: { instituteId: auth.instituteId } },
      OR: [{ batchId }, { teacherId }, ...(room ? [{ room }] : [])],
    },
    select: slotSelect,
  });

  return rows.map(toShape);
}

export async function createSlot(auth: AuthContext, input: SlotInput) {
  const timeProblem = validateSlotTimes(input.startTimeMin, input.endTimeMin);
  if (timeProblem) throw unprocessable(timeProblem);

  await assertOwnership(auth, input);

  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    throw unprocessable('The end date must fall on or after the start date.');
  }

  // The teacher must actually be assigned to teach this subject to this batch,
  // otherwise the timetable and the assignment table drift apart and the
  // daily-log compliance report starts blaming the wrong person.
  const assignment = await prisma.teacherAssignment.findUnique({
    where: {
      teacherId_batchId_subjectId: {
        teacherId: input.teacherId,
        batchId: input.batchId,
        subjectId: input.subjectId,
      },
    },
    select: { id: true },
  });

  if (!assignment) {
    throw unprocessable(
      'That teacher is not assigned to this subject for this batch. Create the assignment first.',
    );
  }

  const candidate: SlotShape = {
    batchId: input.batchId,
    subjectId: input.subjectId,
    teacherId: input.teacherId,
    weekday: input.weekday,
    startTimeMin: input.startTimeMin,
    endTimeMin: input.endTimeMin,
    room: input.room ?? null,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    isActive: true,
  };

  const existing = await loadPotentialClashes(
    auth,
    input.weekday,
    input.batchId,
    input.teacherId,
    input.room ?? null,
  );

  const clashes = findConflicts(candidate, existing);
  if (clashes.length > 0) {
    throw conflict('That slot clashes with the existing timetable.', { conflicts: clashes });
  }

  return prisma.timetableSlot.create({
    data: {
      batchId: input.batchId,
      subjectId: input.subjectId,
      teacherId: input.teacherId,
      weekday: input.weekday,
      startTimeMin: input.startTimeMin,
      endTimeMin: input.endTimeMin,
      room: input.room || null,
      effectiveFrom: toUtcDate(input.effectiveFrom),
      effectiveTo: input.effectiveTo ? toUtcDate(input.effectiveTo) : null,
    },
  });
}

export async function updateSlot(
  auth: AuthContext,
  slotId: string,
  input: Partial<SlotInput> & { isActive?: boolean },
) {
  const existing = await prisma.timetableSlot.findFirst({
    where: { id: slotId, batch: { classGroup: { instituteId: auth.instituteId } } },
    select: slotSelect,
  });

  if (!existing) throw notFound('Timetable slot');

  const merged: SlotShape = {
    ...toShape(existing),
    ...(input.batchId ? { batchId: input.batchId } : {}),
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    ...(input.teacherId ? { teacherId: input.teacherId } : {}),
    ...(input.weekday ? { weekday: input.weekday } : {}),
    ...(input.startTimeMin !== undefined ? { startTimeMin: input.startTimeMin } : {}),
    ...(input.endTimeMin !== undefined ? { endTimeMin: input.endTimeMin } : {}),
    ...(input.room !== undefined ? { room: input.room ?? null } : {}),
    ...(input.effectiveFrom ? { effectiveFrom: input.effectiveFrom } : {}),
    ...(input.effectiveTo !== undefined ? { effectiveTo: input.effectiveTo ?? null } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    id: slotId,
  };

  const timeProblem = validateSlotTimes(merged.startTimeMin, merged.endTimeMin);
  if (timeProblem) throw unprocessable(timeProblem);

  await assertOwnership(auth, input);

  if (merged.isActive) {
    const clashes = findConflicts(
      merged,
      await loadPotentialClashes(
        auth,
        merged.weekday as Weekday,
        merged.batchId,
        merged.teacherId,
        merged.room,
      ),
    );

    if (clashes.length > 0) {
      throw conflict('That change clashes with the existing timetable.', { conflicts: clashes });
    }
  }

  const after = await prisma.timetableSlot.update({
    where: { id: slotId },
    data: {
      batchId: merged.batchId,
      subjectId: merged.subjectId,
      teacherId: merged.teacherId,
      weekday: merged.weekday as Weekday,
      startTimeMin: merged.startTimeMin,
      endTimeMin: merged.endTimeMin,
      room: merged.room,
      effectiveFrom: toUtcDate(merged.effectiveFrom),
      effectiveTo: merged.effectiveTo ? toUtcDate(merged.effectiveTo) : null,
      isActive: merged.isActive,
    },
  });

  return { before: existing, after };
}

export async function deleteSlot(auth: AuthContext, slotId: string) {
  const existing = await prisma.timetableSlot.findFirst({
    where: { id: slotId, batch: { classGroup: { instituteId: auth.instituteId } } },
    select: { id: true, weekday: true, startTimeMin: true },
  });

  if (!existing) throw notFound('Timetable slot');

  // Deactivated rather than deleted: past class sessions point at this slot and
  // the attendance attached to them must stay explicable.
  await prisma.timetableSlot.update({ where: { id: slotId }, data: { isActive: false } });
  return existing;
}

export interface GenerationReport {
  from: string;
  to: string;
  daysConsidered: number;
  created: number;
  skippedExisting: number;
  reconciled: number;
}

/**
 * Materialises class sessions from the timetable across a date range.
 *
 * Idempotent: the unique key on (batchId, sessionDate, startTimeMin) means a
 * second run over the same window creates nothing. That matters because the
 * nightly job and an admin pressing the button can easily overlap.
 */
export async function generateSessions(
  auth: AuthContext,
  args: { from: string; to: string; batchId?: string | undefined; reconcile: boolean },
): Promise<GenerationReport> {
  if (args.to < args.from) throw unprocessable('The end date must fall on or after the start date.');

  const days = dateRange(args.from, args.to, 120);
  if (days.length === 0) throw unprocessable('That date range is empty.');

  const slots = await prisma.timetableSlot.findMany({
    where: {
      isActive: true,
      batch: { classGroup: { instituteId: auth.instituteId }, deletedAt: null, isActive: true },
      ...(args.batchId ? { batchId: args.batchId } : {}),
      effectiveFrom: { lte: toUtcDate(args.to) },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: toUtcDate(args.from) } }],
    },
    select: slotSelect,
  });

  const report: GenerationReport = {
    from: args.from,
    to: args.to,
    daysConsidered: days.length,
    created: 0,
    skippedExisting: 0,
    reconciled: 0,
  };

  for (const day of days) {
    const weekday = weekdayOf(day);

    for (const slot of slots) {
      if (slot.weekday !== weekday) continue;

      const from = toDateString(slot.effectiveFrom);
      const to = dateOnly(slot.effectiveTo);
      if (day < from) continue;
      if (to !== null && day > to) continue;

      const existing = await prisma.classSession.findUnique({
        where: {
          batchId_sessionDate_startTimeMin: {
            batchId: slot.batchId,
            sessionDate: toUtcDate(day),
            startTimeMin: slot.startTimeMin,
          },
        },
        select: { id: true, status: true, teacherId: true, subjectId: true, endTimeMin: true },
      });

      if (existing) {
        report.skippedExisting += 1;

        // Only a session that has not happened yet may be realigned. Rewriting
        // a completed session would orphan its attendance and daily log.
        if (
          args.reconcile &&
          existing.status === SessionStatus.SCHEDULED &&
          (existing.teacherId !== slot.teacherId ||
            existing.subjectId !== slot.subjectId ||
            existing.endTimeMin !== slot.endTimeMin)
        ) {
          await prisma.classSession.update({
            where: { id: existing.id },
            data: {
              teacherId: slot.teacherId,
              subjectId: slot.subjectId,
              endTimeMin: slot.endTimeMin,
              room: slot.room,
              timetableSlotId: slot.id,
            },
          });
          report.reconciled += 1;
        }

        continue;
      }

      await prisma.classSession.create({
        data: {
          batchId: slot.batchId,
          subjectId: slot.subjectId,
          teacherId: slot.teacherId,
          timetableSlotId: slot.id,
          sessionDate: toUtcDate(day),
          startTimeMin: slot.startTimeMin,
          endTimeMin: slot.endTimeMin,
          room: slot.room,
        },
      });
      report.created += 1;
    }
  }

  return report;
}

export async function listSessions(
  auth: AuthContext,
  args: {
    from?: string | undefined;
    to?: string | undefined;
    batchId?: string | undefined;
    teacherId?: string | undefined;
    subjectId?: string | undefined;
    status?: SessionStatus | undefined;
    limit: number;
  },
) {
  const where: Prisma.ClassSessionWhereInput = {
    batch: batchVisibilityFilter(auth),
    ...(args.batchId ? { batchId: args.batchId } : {}),
    ...(args.subjectId ? { subjectId: args.subjectId } : {}),
    ...(args.status ? { status: args.status } : {}),
    ...(args.from || args.to
      ? {
          sessionDate: {
            ...(args.from ? { gte: toUtcDate(args.from) } : {}),
            ...(args.to ? { lte: toUtcDate(args.to) } : {}),
          },
        }
      : {}),
  };

  if (args.teacherId) {
    where.teacherId = args.teacherId;
  } else if (auth.role === Role.TEACHER && auth.profileId) {
    where.teacherId = auth.profileId;
  }

  return prisma.classSession.findMany({
    where,
    orderBy: [{ sessionDate: 'asc' }, { startTimeMin: 'asc' }],
    take: args.limit,
    select: {
      id: true,
      sessionDate: true,
      startTimeMin: true,
      endTimeMin: true,
      room: true,
      status: true,
      actualStartAt: true,
      actualEndAt: true,
      cancelReason: true,
      batch: { select: { id: true, name: true, code: true } },
      subject: { select: { id: true, name: true, code: true, colorHex: true } },
      teacher: {
        select: { id: true, user: { select: { firstName: true, lastName: true } } },
      },
      dailyLog: { select: { id: true, compliance: true, submittedAt: true } },
      _count: { select: { attendance: true } },
    },
  });
}

export async function updateSession(
  auth: AuthContext,
  sessionId: string,
  input: {
    status?: SessionStatus | undefined;
    topicId?: string | null | undefined;
    room?: string | null | undefined;
    cancelReason?: string | undefined;
    actualStartAt?: Date | undefined;
    actualEndAt?: Date | undefined;
  },
) {
  const existing = await prisma.classSession.findFirst({
    where: { id: sessionId, batch: { classGroup: { instituteId: auth.instituteId } } },
    select: { id: true, status: true, teacherId: true, sessionDate: true, startTimeMin: true },
  });

  if (!existing) throw notFound('Class session');

  // A teacher may run their own lectures but not edit a colleague's.
  if (auth.role === Role.TEACHER && existing.teacherId !== auth.profileId) {
    throw unprocessable('You can only update your own class sessions.');
  }

  if (input.status === SessionStatus.CANCELLED && !input.cancelReason) {
    throw unprocessable('Give a reason when cancelling a class; students and parents will see it.');
  }

  const after = await prisma.classSession.update({
    where: { id: sessionId },
    data: {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.topicId !== undefined ? { topicId: input.topicId } : {}),
      ...(input.room !== undefined ? { room: input.room } : {}),
      ...(input.cancelReason !== undefined ? { cancelReason: input.cancelReason } : {}),
      ...(input.actualStartAt !== undefined ? { actualStartAt: input.actualStartAt } : {}),
      ...(input.actualEndAt !== undefined ? { actualEndAt: input.actualEndAt } : {}),
      ...(input.status === SessionStatus.ONGOING && !input.actualStartAt
        ? { actualStartAt: new Date() }
        : {}),
      ...(input.status === SessionStatus.COMPLETED && !input.actualEndAt
        ? { actualEndAt: new Date() }
        : {}),
    },
  });

  return { before: existing, after };
}

/** The next seven days for the caller, used by every dashboard. */
export async function upcomingForCaller(auth: AuthContext, today: string) {
  return listSessions(auth, {
    from: today,
    to: addDays(today, 7),
    status: SessionStatus.SCHEDULED,
    limit: 100,
  });
}
