import {
  ProctoringContext,
  ProctoringEventType,
  ProctoringReviewStatus,
  ProctoringSeverity,
  Prisma,
  Role,
} from '@prisma/client';
import { forbidden, notFound, unprocessable } from '../../lib/http-error';
import { prisma } from '../../lib/prisma';
import { studentVisibilityFilter } from '../../lib/scope';
import type { AuthContext } from '../../types/express';
import {
  PROCTORING_DISCLAIMER,
  severityFor,
  studentNotice,
  summarise,
  type EventType,
  type RawEvent,
} from './proctoring.signals';

export interface IncomingEvent {
  type: ProctoringEventType;
  occurredAt: Date;
  durationMs?: number | undefined;
  detail?: Record<string, unknown> | undefined;
  clientTimestamp?: Date | undefined;
}

/** Which session an observation belongs to, and that it is the caller's own. */
async function resolveContext(
  auth: AuthContext,
  context: ProctoringContext,
  sessionId: string,
): Promise<{ studentId: string; link: Record<string, string> }> {
  if (context === ProctoringContext.VIVA) {
    const session = await prisma.vivaSession.findFirst({
      where: { id: sessionId, student: studentVisibilityFilter(auth) },
      select: { id: true, studentId: true, proctoringEnabled: true, consentGivenAt: true },
    });

    if (!session) throw notFound('Viva session');

    // Recording without consent is not a bug to be tolerated; it is refused.
    if (!session.proctoringEnabled || !session.consentGivenAt) {
      throw unprocessable('Monitoring is not enabled for this session, so no events are recorded.');
    }

    return { studentId: session.studentId, link: { vivaSessionId: session.id } };
  }

  if (context === ProctoringContext.TEST) {
    const attempt = await prisma.testAttempt.findFirst({
      where: { id: sessionId, student: studentVisibilityFilter(auth) },
      select: { id: true, studentId: true, test: { select: { proctoringEnabled: true } } },
    });

    if (!attempt) throw notFound('Test attempt');
    if (!attempt.test.proctoringEnabled) {
      throw unprocessable('This test is not monitored, so no events are recorded.');
    }

    return { studentId: attempt.studentId, link: { testAttemptId: attempt.id } };
  }

  const session = await prisma.practiceSession.findFirst({
    where: { id: sessionId, student: studentVisibilityFilter(auth) },
    select: { id: true, studentId: true },
  });

  if (!session) throw notFound('Practice session');
  return { studentId: session.studentId, link: { practiceSessionId: session.id } };
}

export interface IngestReport {
  recorded: number;
  /** Shown to the student immediately, so nothing is observed covertly. */
  notices: { type: ProctoringEventType; message: string }[];
}

/**
 * Records a batch of observations.
 *
 * Events arrive in batches from the browser rather than one at a time, which
 * keeps a 5fps detector from generating a request per frame. Severity is
 * recomputed server-side: a client is free to claim an event was INFO, and
 * trusting that would let a modified client suppress its own record.
 */
export async function ingestEvents(
  auth: AuthContext,
  context: ProctoringContext,
  sessionId: string,
  events: IncomingEvent[],
): Promise<IngestReport> {
  const resolved = await resolveContext(auth, context, sessionId);

  if (auth.role === Role.STUDENT && resolved.studentId !== auth.profileId) {
    throw forbidden('That is not your session.');
  }

  const notices: { type: ProctoringEventType; message: string }[] = [];
  const seen = new Set<ProctoringEventType>();

  await prisma.$transaction(
    events.map((event) => {
      const severity = severityFor(event.type as EventType, event.durationMs);

      if (!seen.has(event.type)) {
        seen.add(event.type);
        notices.push({ type: event.type, message: studentNotice(event.type as EventType) });
      }

      return prisma.proctoringEvent.create({
        data: {
          studentId: resolved.studentId,
          context,
          ...resolved.link,
          type: event.type,
          severity: severity as ProctoringSeverity,
          occurredAt: event.occurredAt,
          durationMs: event.durationMs ?? null,
          detail: (event.detail ?? undefined) as Prisma.InputJsonValue | undefined,
          clientTimestamp: event.clientTimestamp ?? null,
        },
      });
    }),
  );

  return { recorded: events.length, notices };
}

export interface SessionReview {
  context: ProctoringContext;
  sessionId: string;
  student: { id: string; name: string } | null;
  summary: ReturnType<typeof summarise>;
  events: {
    id: string;
    type: ProctoringEventType;
    severity: ProctoringSeverity;
    occurredAt: Date;
    durationMs: number | null;
    reviewStatus: ProctoringReviewStatus;
    reviewNote: string | null;
  }[];
}

/**
 * The reviewer's view of one session.
 *
 * Built through the pure summariser, so what a teacher reads carries the same
 * disclaimer and the same benign explanations that were designed alongside the
 * thresholds. There is no path that produces a bare list of red flags.
 */
export async function reviewSession(
  auth: AuthContext,
  context: ProctoringContext,
  sessionId: string,
): Promise<SessionReview> {
  const key =
    context === ProctoringContext.VIVA
      ? { vivaSessionId: sessionId }
      : context === ProctoringContext.TEST
        ? { testAttemptId: sessionId }
        : { practiceSessionId: sessionId };

  const events = await prisma.proctoringEvent.findMany({
    where: {
      ...key,
      student: studentVisibilityFilter(auth),
    },
    orderBy: { occurredAt: 'asc' },
    select: {
      id: true,
      type: true,
      severity: true,
      occurredAt: true,
      durationMs: true,
      reviewStatus: true,
      reviewNote: true,
      student: {
        select: { id: true, user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  const first = events[0];
  const last = events[events.length - 1];

  const durationMs =
    first && last
      ? Math.max(
          1,
          last.occurredAt.getTime() + (last.durationMs ?? 0) - first.occurredAt.getTime(),
        )
      : 0;

  const raw: RawEvent[] = events.map((event) => ({
    type: event.type as EventType,
    occurredAt: event.occurredAt.getTime(),
    durationMs: event.durationMs ?? 0,
  }));

  return {
    context,
    sessionId,
    student: first
      ? {
          id: first.student.id,
          name: `${first.student.user.firstName} ${first.student.user.lastName}`,
        }
      : null,
    summary: summarise(raw, durationMs),
    events: events.map(({ student: _student, ...rest }) => rest),
  };
}

/**
 * A teacher's verdict on an observation.
 *
 * Recorded against the event so the record shows a human looked and what they
 * concluded. An unreviewed event is exactly that, and no dashboard should
 * present it as anything more.
 */
export async function reviewEvent(
  auth: AuthContext,
  eventId: string,
  input: { status: ProctoringReviewStatus; note?: string | undefined },
) {
  if (auth.role !== Role.TEACHER && auth.role !== Role.ADMIN) {
    throw forbidden('Only a teacher or administrator can review proctoring observations.');
  }

  const event = await prisma.proctoringEvent.findFirst({
    where: { id: eventId, student: studentVisibilityFilter(auth) },
    select: { id: true, type: true, reviewStatus: true },
  });

  if (!event) throw notFound('Proctoring event');

  if (input.status === ProctoringReviewStatus.ESCALATED && !input.note) {
    throw unprocessable(
      'Escalating requires a written note. A student is entitled to know what was concluded and why.',
    );
  }

  return prisma.proctoringEvent.update({
    where: { id: eventId },
    data: {
      reviewStatus: input.status,
      reviewNote: input.note ?? null,
      reviewedById: auth.userId,
      reviewedAt: new Date(),
    },
    select: { id: true, reviewStatus: true, reviewNote: true, reviewedAt: true },
  });
}

/** The review queue: sessions where a human has not yet looked. */
export async function pendingReview(auth: AuthContext, limit = 50) {
  if (auth.aggregateOnly) {
    throw forbidden(
      'This account is limited to aggregate reporting and cannot open individual proctoring records.',
    );
  }

  const events = await prisma.proctoringEvent.findMany({
    where: {
      reviewStatus: ProctoringReviewStatus.UNREVIEWED,
      severity: { in: [ProctoringSeverity.MEDIUM, ProctoringSeverity.HIGH] },
      student: studentVisibilityFilter(auth),
    },
    orderBy: { occurredAt: 'desc' },
    take: limit,
    select: {
      id: true,
      type: true,
      severity: true,
      occurredAt: true,
      durationMs: true,
      context: true,
      vivaSessionId: true,
      testAttemptId: true,
      practiceSessionId: true,
      student: {
        select: { id: true, user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  return {
    disclaimer: PROCTORING_DISCLAIMER,
    events: events.map((event) => ({
      ...event,
      studentName: `${event.student.user.firstName} ${event.student.user.lastName}`,
    })),
  };
}

/**
 * Institute-wide counts.
 *
 * Deliberately anonymous. Management gets to see whether monitoring is
 * producing an unmanageable volume of observations, which is an operational
 * question, without seeing which children generated them.
 */
export async function proctoringOverview(auth: AuthContext, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);

  const [byType, bySeverity, reviewed] = await Promise.all([
    prisma.proctoringEvent.groupBy({
      by: ['type'],
      where: { occurredAt: { gte: since }, student: { user: { instituteId: auth.instituteId } } },
      _count: { _all: true },
    }),
    prisma.proctoringEvent.groupBy({
      by: ['severity'],
      where: { occurredAt: { gte: since }, student: { user: { instituteId: auth.instituteId } } },
      _count: { _all: true },
    }),
    prisma.proctoringEvent.groupBy({
      by: ['reviewStatus'],
      where: { occurredAt: { gte: since }, student: { user: { instituteId: auth.instituteId } } },
      _count: { _all: true },
    }),
  ]);

  const total = bySeverity.reduce((sum, row) => sum + row._count._all, 0);
  const unreviewed =
    reviewed.find((row) => row.reviewStatus === ProctoringReviewStatus.UNREVIEWED)?._count._all ?? 0;
  const dismissed =
    reviewed.find((row) => row.reviewStatus === ProctoringReviewStatus.DISMISSED)?._count._all ?? 0;

  return {
    windowDays: days,
    totalObservations: total,
    byType,
    bySeverity,
    unreviewed,
    // A high dismissal rate means the thresholds are too sensitive and are
    // wasting teachers' attention; that is worth showing plainly.
    dismissedPct: total > 0 ? Math.round((dismissed / total) * 100) : 0,
    disclaimer: PROCTORING_DISCLAIMER,
  };
}
