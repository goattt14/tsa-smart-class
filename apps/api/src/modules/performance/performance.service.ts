import { Difficulty, MasteryLevel, Prisma, RecommendationKind, Role } from '@prisma/client';
import { forbidden, notFound } from '../../lib/http-error';
import { prisma } from '../../lib/prisma';
import { studentVisibilityFilter } from '../../lib/scope';
import { toDateString, toUtcDate } from '../../lib/time';
import type { AuthContext } from '../../types/express';
import {
  applyOutcome,
  buildRecommendations,
  INITIAL_MASTERY,
  rollUpSubject,
  type AttemptOutcome,
  type TopicSnapshot,
  type TopicMasteryState,
} from './mastery';

async function assertVisible(auth: AuthContext, studentId: string): Promise<void> {
  const visible = await prisma.studentProfile.findFirst({
    where: { AND: [{ id: studentId }, studentVisibilityFilter(auth)] },
    select: { id: true },
  });
  if (!visible) throw forbidden('You do not have access to this student.');
}

/**
 * Folds one graded answer into the student's mastery of its topic.
 *
 * Called after every test submission and, from Phase 4, after every practice
 * answer and viva. Upserting per outcome keeps the record current rather than
 * waiting on a nightly batch that would leave a dashboard a day stale.
 */
export async function recordOutcome(
  studentId: string,
  topicId: string,
  outcome: AttemptOutcome,
): Promise<TopicMasteryState> {
  const existing = await prisma.topicMastery.findUnique({
    where: { studentId_topicId: { studentId, topicId } },
    select: {
      score: true,
      level: true,
      attempts: true,
      correctCount: true,
      consecutiveRight: true,
      avgTimeSec: true,
    },
  });

  const current: TopicMasteryState = existing
    ? {
        score: existing.score,
        level: existing.level,
        attempts: existing.attempts,
        correctCount: existing.correctCount,
        consecutiveRight: existing.consecutiveRight,
        avgTimeSec: existing.avgTimeSec,
      }
    : INITIAL_MASTERY;

  const next = applyOutcome(current, outcome);

  await prisma.topicMastery.upsert({
    where: { studentId_topicId: { studentId, topicId } },
    update: {
      score: next.score,
      level: next.level as MasteryLevel,
      attempts: next.attempts,
      correctCount: next.correctCount,
      consecutiveRight: next.consecutiveRight,
      avgTimeSec: next.avgTimeSec,
      lastAssessedAt: new Date(),
    },
    create: {
      studentId,
      topicId,
      score: next.score,
      level: next.level as MasteryLevel,
      attempts: next.attempts,
      correctCount: next.correctCount,
      consecutiveRight: next.consecutiveRight,
      avgTimeSec: next.avgTimeSec,
      lastAssessedAt: new Date(),
    },
  });

  return next;
}

/** Processes a whole submitted attempt into mastery updates. */
export async function ingestAttempt(attemptId: string): Promise<number> {
  const answers = await prisma.testAnswer.findMany({
    where: { attemptId, isCorrect: { not: null } },
    select: {
      isCorrect: true,
      marksAwarded: true,
      timeTakenSec: true,
      attempt: { select: { studentId: true } },
      testQuestion: {
        select: {
          marks: true,
          question: { select: { marks: true, difficulty: true, topicId: true } },
        },
      },
    },
  });

  let updated = 0;

  for (const answer of answers) {
    const topicId = answer.testQuestion.question.topicId;
    if (!topicId) continue;

    const ceiling = answer.testQuestion.marks ?? answer.testQuestion.question.marks;
    const creditFraction =
      ceiling > 0 && answer.marksAwarded !== null
        ? Math.max(0, Math.min(1, answer.marksAwarded / ceiling))
        : answer.isCorrect
          ? 1
          : 0;

    await recordOutcome(answer.attempt.studentId, topicId, {
      isCorrect: answer.isCorrect === true,
      creditFraction,
      difficulty: answer.testQuestion.question.difficulty,
      timeTakenSec: answer.timeTakenSec,
    });

    updated += 1;
  }

  return updated;
}

async function loadSnapshots(studentId: string, subjectId?: string): Promise<TopicSnapshot[]> {
  const topics = await prisma.topic.findMany({
    where: {
      isActive: true,
      ...(subjectId ? { subjectId } : {}),
    },
    select: {
      id: true,
      name: true,
      mastery: {
        where: { studentId },
        select: {
          score: true,
          level: true,
          attempts: true,
          correctCount: true,
          consecutiveRight: true,
          avgTimeSec: true,
          lastAssessedAt: true,
        },
      },
      classSessions: {
        where: { status: 'COMPLETED' },
        take: 1,
        select: { id: true },
      },
    },
  });

  const now = Date.now();

  return topics.map((topic) => {
    const row = topic.mastery[0];

    return {
      topicId: topic.id,
      topicName: topic.name,
      taughtInClass: topic.classSessions.length > 0,
      daysSinceAssessed: row?.lastAssessedAt
        ? Math.floor((now - row.lastAssessedAt.getTime()) / 86_400_000)
        : null,
      state: row
        ? {
            score: row.score,
            level: row.level,
            attempts: row.attempts,
            correctCount: row.correctCount,
            consecutiveRight: row.consecutiveRight,
            avgTimeSec: row.avgTimeSec,
          }
        : INITIAL_MASTERY,
    };
  });
}

/** The full performance picture for one student. */
export async function studentOverview(auth: AuthContext, studentId: string) {
  await assertVisible(auth, studentId);

  const [student, snapshots, attempts, attendance] = await Promise.all([
    prisma.studentProfile.findUniqueOrThrow({
      where: { id: studentId },
      select: {
        id: true,
        admissionNumber: true,
        user: { select: { firstName: true, lastName: true, avatarUrl: true } },
      },
    }),
    loadSnapshots(studentId),
    prisma.testAttempt.findMany({
      where: { studentId, status: 'EVALUATED' },
      orderBy: { submittedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        score: true,
        percentage: true,
        rank: true,
        isPassed: true,
        submittedAt: true,
        test: {
          select: {
            title: true,
            maxMarks: true,
            resultsPublished: true,
            subject: { select: { id: true, name: true, colorHex: true } },
          },
        },
      },
    }),
    prisma.attendance.groupBy({
      by: ['status'],
      where: { studentId },
      _count: { _all: true },
    }),
  ]);

  const subjects = await prisma.subject.findMany({
    where: { instituteId: auth.instituteId, deletedAt: null, isActive: true },
    select: { id: true, name: true, colorHex: true },
  });

  const bySubject = await Promise.all(
    subjects.map(async (subject) => {
      const scoped = await loadSnapshots(studentId, subject.id);
      return { subject, rollup: rollUpSubject(scoped) };
    }),
  );

  const attendanceCounts = Object.fromEntries(
    attendance.map((row) => [row.status, row._count._all]),
  ) as Record<string, number>;

  const present = (attendanceCounts.PRESENT ?? 0) + (attendanceCounts.LATE ?? 0);
  const counted =
    present + (attendanceCounts.ABSENT ?? 0);

  return {
    student: {
      id: student.id,
      name: `${student.user.firstName} ${student.user.lastName}`,
      admissionNumber: student.admissionNumber,
      avatarUrl: student.user.avatarUrl,
    },
    attendancePct: counted > 0 ? Math.round((present / counted) * 100) : null,
    // Only published results reach a student or parent; an unpublished mark
    // would leak the outcome before the teacher had released it.
    recentTests: attempts.filter(
      (a) => a.test.resultsPublished || auth.role === Role.TEACHER || auth.role === Role.ADMIN,
    ),
    subjects: bySubject.filter((entry) => entry.rollup.masteryScore > 0 || entry.rollup.weakTopics.length > 0),
    recommendations: buildRecommendations(snapshots),
    topicCount: snapshots.filter((s) => s.state.attempts > 0).length,
  };
}

/** Persists the current recommendations so they can be dismissed and tracked. */
export async function refreshRecommendations(
  auth: AuthContext,
  studentId: string,
): Promise<number> {
  await assertVisible(auth, studentId);

  const snapshots = await loadSnapshots(studentId);
  const recommendations = buildRecommendations(snapshots);

  await prisma.learningRecommendation.deleteMany({
    where: { studentId, isDismissed: false, actedOnAt: null },
  });

  for (const recommendation of recommendations) {
    await prisma.learningRecommendation.create({
      data: {
        studentId,
        topicId: recommendation.topicId,
        kind: recommendation.kind as RecommendationKind,
        title: recommendation.title,
        reason: recommendation.reason,
        priority: recommendation.priority,
      },
    });
  }

  return recommendations.length;
}

export async function dismissRecommendation(auth: AuthContext, recommendationId: string) {
  const record = await prisma.learningRecommendation.findFirst({
    where: { id: recommendationId, student: studentVisibilityFilter(auth) },
    select: { id: true },
  });

  if (!record) throw notFound('Recommendation');

  return prisma.learningRecommendation.update({
    where: { id: recommendationId },
    data: { isDismissed: true },
    select: { id: true, isDismissed: true },
  });
}

/** Rebuilds the subject-level profile from topic mastery. */
export async function refreshLearningProfiles(
  auth: AuthContext,
  studentId: string,
): Promise<number> {
  await assertVisible(auth, studentId);

  const subjects = await prisma.subject.findMany({
    where: { instituteId: auth.instituteId, deletedAt: null },
    select: { id: true },
  });

  let updated = 0;

  for (const subject of subjects) {
    const snapshots = await loadSnapshots(studentId, subject.id);
    const rollup = rollUpSubject(snapshots);

    if (rollup.masteryScore === 0 && snapshots.every((s) => s.state.attempts === 0)) continue;

    await prisma.studentLearningProfile.upsert({
      where: { studentId_subjectId: { studentId, subjectId: subject.id } },
      update: {
        masteryLevel: rollup.masteryLevel as MasteryLevel,
        masteryScore: rollup.masteryScore,
        preferredDifficulty: rollup.preferredDifficulty as Difficulty,
        strongTopics: rollup.strongTopics as unknown as Prisma.InputJsonValue,
        weakTopics: rollup.weakTopics as unknown as Prisma.InputJsonValue,
        lastAssessedAt: new Date(),
        lastUpdatedBy: 'TEST',
      },
      create: {
        studentId,
        subjectId: subject.id,
        masteryLevel: rollup.masteryLevel as MasteryLevel,
        masteryScore: rollup.masteryScore,
        preferredDifficulty: rollup.preferredDifficulty as Difficulty,
        strongTopics: rollup.strongTopics as unknown as Prisma.InputJsonValue,
        weakTopics: rollup.weakTopics as unknown as Prisma.InputJsonValue,
        lastAssessedAt: new Date(),
        lastUpdatedBy: 'TEST',
      },
    });

    updated += 1;
  }

  return updated;
}

/**
 * Batch-level distribution. Counts only, no names, so this is the view
 * management is meant to read.
 */
export async function batchPerformance(auth: AuthContext, batchId: string) {
  const batch = await prisma.batch.findFirst({
    where: { id: batchId, classGroup: { instituteId: auth.instituteId } },
    select: { id: true, name: true },
  });

  if (!batch) throw notFound('Batch');

  const attempts = await prisma.testAttempt.findMany({
    where: {
      test: { batchId },
      status: 'EVALUATED',
      percentage: { not: null },
    },
    select: { percentage: true },
  });

  const bands = { below35: 0, band35to50: 0, band50to70: 0, band70to85: 0, above85: 0 };

  for (const attempt of attempts) {
    const pct = attempt.percentage ?? 0;
    if (pct < 35) bands.below35 += 1;
    else if (pct < 50) bands.band35to50 += 1;
    else if (pct < 70) bands.band50to70 += 1;
    else if (pct < 85) bands.band70to85 += 1;
    else bands.above85 += 1;
  }

  const average =
    attempts.length > 0
      ? Math.round(
          (attempts.reduce((sum, a) => sum + (a.percentage ?? 0), 0) / attempts.length) * 10,
        ) / 10
      : null;

  return { batch, sampleSize: attempts.length, averagePct: average, distribution: bands };
}

/** Writes a dated metric row, so trends survive even as live data changes. */
export async function snapshotMetric(input: {
  scope: 'STUDENT' | 'BATCH' | 'TEACHER' | 'INSTITUTE';
  scopeId: string | null;
  metricKey: string;
  periodType: 'DAY' | 'WEEK' | 'MONTH' | 'TERM';
  periodStart: string;
  periodEnd: string;
  value: number;
  sampleSize: number;
  studentId?: string | null;
  subjectId?: string | null;
}) {
  const existing = await prisma.performanceMetric.findFirst({
    where: {
      scope: input.scope,
      scopeId: input.scopeId,
      metricKey: input.metricKey,
      periodType: input.periodType,
      periodStart: toUtcDate(input.periodStart),
      studentId: input.studentId ?? null,
      subjectId: input.subjectId ?? null,
    },
    select: { id: true },
  });

  if (existing) {
    return prisma.performanceMetric.update({
      where: { id: existing.id },
      data: { value: input.value, sampleSize: input.sampleSize, computedAt: new Date() },
    });
  }

  return prisma.performanceMetric.create({
    data: {
      scope: input.scope,
      scopeId: input.scopeId,
      metricKey: input.metricKey,
      periodType: input.periodType,
      periodStart: toUtcDate(input.periodStart),
      periodEnd: toUtcDate(input.periodEnd),
      value: input.value,
      sampleSize: input.sampleSize,
      studentId: input.studentId ?? null,
      subjectId: input.subjectId ?? null,
    },
  });
}

export async function metricSeries(
  auth: AuthContext,
  args: { metricKey: string; scope: string; scopeId?: string | undefined; from: string; to: string },
) {
  const rows = await prisma.performanceMetric.findMany({
    where: {
      metricKey: args.metricKey,
      scope: args.scope,
      ...(args.scopeId ? { scopeId: args.scopeId } : {}),
      periodStart: { gte: toUtcDate(args.from), lte: toUtcDate(args.to) },
    },
    orderBy: { periodStart: 'asc' },
    select: { periodStart: true, value: true, sampleSize: true },
  });

  return rows.map((row) => ({
    date: toDateString(row.periodStart),
    value: row.value,
    sampleSize: row.sampleSize,
  }));
}
