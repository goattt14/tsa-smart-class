import { AttemptStatus, Prisma, Role, TestType } from '@prisma/client';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/http-error';
import { prisma } from '../../lib/prisma';
import { batchVisibilityFilter, studentVisibilityFilter } from '../../lib/scope';
import { toUtcDate } from '../../lib/time';
import type { AuthContext } from '../../types/express';
import { unpackScheme } from '../questions/questions.service';
import {
  gradeAnswer,
  rankAttempts,
  scoreAttempt,
  type GradableQuestion,
  type GradeResult,
  type GradingOptions,
  type QuestionType as GradableType,
} from './grading';

/**
 * Per-test grading options have no column, so they ride in the description
 * envelope the same way numeric tolerance rides in markingScheme. Both readers
 * go through this pair, so authoring and grading cannot drift apart.
 */
interface TestConfig {
  negativeMarkingFraction: number;
  allowPartialCredit: boolean;
}

const DEFAULT_CONFIG: TestConfig = { negativeMarkingFraction: 0, allowPartialCredit: true };

export async function loadTestConfig(testId: string): Promise<GradingOptions> {
  const setting = await prisma.systemSetting.findFirst({
    where: { key: `test.grading.${testId}` },
    select: { value: true },
  });

  if (!setting?.value || typeof setting.value !== 'object') return DEFAULT_CONFIG;
  return { ...DEFAULT_CONFIG, ...(setting.value as Partial<TestConfig>) };
}

async function saveTestConfig(testId: string, config: Partial<TestConfig>, instituteId?: string): Promise<void> {
  const key = `test.grading.${testId}`;
  const value = { ...DEFAULT_CONFIG, ...config } as Prisma.InputJsonValue;

  if (instituteId) {
    await prisma.systemSetting.upsert({
      where: { instituteId_key: { instituteId, key } },
      update: { value },
      create: {
        instituteId,
        key,
        value,
        description: 'Grading options for a single test',
      },
    });
    return;
  }

  // Fallback when instituteId not known - find any existing then create/update
  const existing = await prisma.systemSetting.findFirst({
    where: { key },
    select: { id: true, instituteId: true },
  });

  if (existing) {
    await prisma.systemSetting.update({
      where: { id: existing.id },
      data: { value },
    });
  } else {
    // Need an instituteId - fetch from test
    const test = await prisma.test.findUnique({
      where: { id: testId },
      select: { batch: { select: { classGroup: { select: { instituteId: true } } } } },
    });
    const instId = test?.batch.classGroup.instituteId;
    if (!instId) return;
    await prisma.systemSetting.create({
      data: {
        instituteId: instId,
        key,
        value,
        description: 'Grading options for a single test',
      },
    });
  }
}

export async function listTests(
  auth: AuthContext,
  args: {
    batchId?: string | undefined;
    subjectId?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    isPublished?: boolean | undefined;
    limit: number;
  },
) {
  const where: Prisma.TestWhereInput = {
    deletedAt: null,
    batch: batchVisibilityFilter(auth),
    ...(args.batchId ? { batchId: args.batchId } : {}),
    ...(args.subjectId ? { subjectId: args.subjectId } : {}),
    ...(args.isPublished !== undefined ? { isPublished: args.isPublished } : {}),
    ...(args.from || args.to
      ? {
          scheduledAt: {
            ...(args.from ? { gte: toUtcDate(args.from) } : {}),
            ...(args.to ? { lte: toUtcDate(args.to) } : {}),
          },
        }
      : {}),
  };

  // A student has no business seeing a paper that has not been published.
  if (auth.role === Role.STUDENT || auth.role === Role.PARENT) {
    where.isPublished = true;
  }

  return prisma.test.findMany({
    where,
    orderBy: { scheduledAt: 'desc' },
    take: args.limit,
    select: {
      id: true,
      title: true,
      type: true,
      scheduledAt: true,
      durationMin: true,
      maxMarks: true,
      passingMarks: true,
      isPublished: true,
      resultsPublished: true,
      proctoringEnabled: true,
      batch: { select: { id: true, name: true } },
      subject: { select: { id: true, name: true, colorHex: true } },
      _count: { select: { questions: true, attempts: true } },
    },
  });
}

export async function createTest(
  auth: AuthContext,
  input: {
    batchId: string;
    subjectId: string;
    title: string;
    description?: string | undefined;
    type: TestType;
    scheduledAt: Date;
    durationMin: number;
    passingPct: number;
    shuffleQuestions: boolean;
    proctoringEnabled: boolean;
    allowLateStartMin: number;
    negativeMarkingFraction: number;
  },
) {
  const batch = await prisma.batch.findFirst({
    where: { AND: [{ id: input.batchId }, batchVisibilityFilter(auth)] },
    select: { id: true },
  });
  if (!batch) throw forbidden('You are not assigned to that batch.');

  const teacherId =
    auth.role === Role.TEACHER
      ? auth.profileId
      : (
          await prisma.teacherAssignment.findFirst({
            where: { batchId: input.batchId, subjectId: input.subjectId },
            select: { teacherId: true },
          })
        )?.teacherId;

  if (!teacherId) {
    throw unprocessable('No teacher is assigned to that subject for this batch.');
  }

  const test = await prisma.test.create({
    data: {
      batchId: input.batchId,
      subjectId: input.subjectId,
      teacherId,
      title: input.title,
      description: input.description || null,
      type: input.type,
      scheduledAt: input.scheduledAt,
      durationMin: input.durationMin,
      // Both totals are recomputed from the attached questions; they start at
      // zero rather than at a guess nobody will remember to correct.
      maxMarks: 0,
      passingMarks: 0,
      shuffleQuestions: input.shuffleQuestions,
      proctoringEnabled: input.proctoringEnabled,
      allowLateStartMin: input.allowLateStartMin,
    },
  });

  await saveTestConfig(test.id, {
    negativeMarkingFraction: input.negativeMarkingFraction,
  }, auth.instituteId);

  return { test, passingPct: input.passingPct };
}

async function loadEditableTest(auth: AuthContext, testId: string) {
  const test = await prisma.test.findFirst({
    where: { id: testId, deletedAt: null, batch: { classGroup: { instituteId: auth.instituteId } } },
    select: {
      id: true,
      teacherId: true,
      isPublished: true,
      resultsPublished: true,
      batchId: true,
      subjectId: true,
      maxMarks: true,
      passingMarks: true,
      durationMin: true,
      scheduledAt: true,
      allowLateStartMin: true,
      shuffleQuestions: true,
      _count: { select: { attempts: true } },
    },
  });

  if (!test) throw notFound('Test');

  if (auth.role === Role.TEACHER && test.teacherId !== auth.profileId) {
    throw forbidden('You can only edit your own tests.');
  }

  return test;
}

/**
 * Replaces the question set and recomputes the totals.
 *
 * Refused once anyone has attempted the paper: changing the questions under a
 * student who has already answered them would invalidate their marks without
 * any trace of what they were actually asked.
 */
export async function setQuestions(
  auth: AuthContext,
  testId: string,
  questions: { questionId: string; marks?: number | undefined }[],
  passingPct: number,
) {
  const test = await loadEditableTest(auth, testId);

  if (test._count.attempts > 0) {
    throw conflict('Students have already attempted this test, so the questions are locked.');
  }

  const ids = questions.map((q) => q.questionId);
  if (new Set(ids).size !== ids.length) {
    throw unprocessable('The same question appears more than once.');
  }

  const found = await prisma.question.findMany({
    where: {
      id: { in: ids },
      deletedAt: null,
      subjectId: test.subjectId,
      subject: { instituteId: auth.instituteId },
    },
    select: { id: true, marks: true },
  });

  if (found.length !== ids.length) {
    throw unprocessable('One or more questions do not exist, or belong to another subject.');
  }

  const defaultMarks = new Map(found.map((q) => [q.id, q.marks]));
  const maxMarks = questions.reduce(
    (sum, q) => sum + (q.marks ?? defaultMarks.get(q.questionId) ?? 0),
    0,
  );

  await prisma.$transaction([
    prisma.testQuestion.deleteMany({ where: { testId } }),
    ...questions.map((q, index) =>
      prisma.testQuestion.create({
        data: {
          testId,
          questionId: q.questionId,
          orderIndex: index,
          marks: q.marks ?? null,
        },
      }),
    ),
    prisma.test.update({
      where: { id: testId },
      data: {
        maxMarks,
        passingMarks: Math.round(maxMarks * (passingPct / 100) * 100) / 100,
      },
    }),
  ]);

  return { questionCount: questions.length, maxMarks };
}

export async function publishTest(auth: AuthContext, testId: string) {
  const test = await loadEditableTest(auth, testId);

  const count = await prisma.testQuestion.count({ where: { testId } });
  if (count === 0) throw unprocessable('Attach at least one question before publishing.');

  if (test.maxMarks <= 0) {
    throw unprocessable('This test totals zero marks. Check the question marks.');
  }

  return prisma.test.update({
    where: { id: testId },
    data: { isPublished: true, publishedAt: new Date() },
  });
}

/** The paper as a student sees it: no answer key, optionally shuffled. */
export async function loadPaper(auth: AuthContext, testId: string, attemptId: string) {
  const attempt = await prisma.testAttempt.findFirst({
    where: { id: attemptId, testId, student: studentVisibilityFilter(auth) },
    select: { id: true, studentId: true, status: true, startedAt: true },
  });

  if (!attempt) throw notFound('Attempt');

  const test = await prisma.test.findUniqueOrThrow({
    where: { id: testId },
    select: { shuffleQuestions: true, durationMin: true, maxMarks: true, title: true },
  });

  const questions = await prisma.testQuestion.findMany({
    where: { testId },
    orderBy: { orderIndex: 'asc' },
    select: {
      id: true,
      orderIndex: true,
      marks: true,
      question: {
        select: {
          id: true,
          type: true,
          difficulty: true,
          body: true,
          options: true,
          marks: true,
          expectedTimeSec: true,
        },
      },
    },
  });

  const answers = await prisma.testAnswer.findMany({
    where: { attemptId },
    select: {
      testQuestionId: true,
      responseText: true,
      selectedOption: true,
      timeTakenSec: true,
    },
  });

  const byQuestion = new Map(answers.map((a) => [a.testQuestionId, a]));

  // Seeded on the attempt id, so a student who refreshes gets the same order
  // rather than a reshuffled paper halfway through.
  const ordered = test.shuffleQuestions
    ? [...questions].sort((a, b) => hash(attemptId + a.id) - hash(attemptId + b.id))
    : questions;

  return {
    title: test.title,
    durationMin: test.durationMin,
    maxMarks: test.maxMarks,
    startedAt: attempt.startedAt,
    status: attempt.status,
    questions: ordered.map((row, index) => ({
      testQuestionId: row.id,
      displayIndex: index + 1,
      marks: row.marks ?? row.question.marks,
      type: row.question.type,
      body: row.question.body,
      options: row.question.options,
      expectedTimeSec: row.question.expectedTimeSec,
      saved: byQuestion.get(row.id) ?? null,
    })),
  };
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export async function startAttempt(auth: AuthContext, testId: string) {
  if (auth.role !== Role.STUDENT || !auth.profileId) {
    throw forbidden('Only a student can sit a test.');
  }

  const test = await prisma.test.findFirst({
    where: { id: testId, deletedAt: null, isPublished: true },
    select: {
      id: true,
      batchId: true,
      scheduledAt: true,
      durationMin: true,
      allowLateStartMin: true,
    },
  });

  if (!test) throw notFound('Test');

  const enrolled = await prisma.enrollment.findFirst({
    where: { batchId: test.batchId, studentId: auth.profileId, status: 'ACTIVE' },
    select: { id: true },
  });

  if (!enrolled) throw forbidden('You are not enrolled in the batch this test belongs to.');

  const now = new Date();
  const opensAt = test.scheduledAt;
  const closesAt = new Date(opensAt.getTime() + test.allowLateStartMin * 60_000);

  if (now < opensAt) {
    throw unprocessable(`This test opens at ${opensAt.toISOString()}.`);
  }
  if (now > closesAt) {
    throw unprocessable(
      `The window to start closed ${test.allowLateStartMin} minutes after the scheduled time.`,
    );
  }

  const existing = await prisma.testAttempt.findUnique({
    where: { testId_studentId: { testId, studentId: auth.profileId } },
    select: { id: true, status: true },
  });

  if (existing) {
    if (existing.status !== AttemptStatus.NOT_STARTED && existing.status !== AttemptStatus.IN_PROGRESS) {
      throw conflict('You have already submitted this test.');
    }

    return prisma.testAttempt.update({
      where: { id: existing.id },
      data: { status: AttemptStatus.IN_PROGRESS, startedAt: new Date() },
    });
  }

  return prisma.testAttempt.create({
    data: {
      testId,
      studentId: auth.profileId,
      status: AttemptStatus.IN_PROGRESS,
      startedAt: now,
    },
  });
}

async function loadOwnAttempt(auth: AuthContext, attemptId: string) {
  const attempt = await prisma.testAttempt.findFirst({
    where: { id: attemptId, student: studentVisibilityFilter(auth) },
    select: {
      id: true,
      testId: true,
      studentId: true,
      status: true,
      startedAt: true,
      test: { select: { durationMin: true, passingMarks: true } },
    },
  });

  if (!attempt) throw notFound('Attempt');

  if (auth.role === Role.STUDENT && attempt.studentId !== auth.profileId) {
    throw forbidden('That is not your attempt.');
  }

  return attempt;
}

/** Time is checked server-side; a client clock is not evidence. */
function hasTimeExpired(startedAt: Date | null, durationMin: number): boolean {
  if (!startedAt) return false;
  return Date.now() > startedAt.getTime() + durationMin * 60_000;
}

export async function saveAnswer(
  auth: AuthContext,
  attemptId: string,
  input: {
    testQuestionId: string;
    responseText?: string | null | undefined;
    selectedOption?: string | string[] | null | undefined;
    inputMode: Prisma.TestAnswerCreateInput['inputMode'];
    timeTakenSec?: number | undefined;
  },
) {
  const attempt = await loadOwnAttempt(auth, attemptId);

  if (attempt.status !== AttemptStatus.IN_PROGRESS) {
    throw conflict('This attempt is no longer open.');
  }

  if (hasTimeExpired(attempt.startedAt, attempt.test.durationMin)) {
    await submitAttempt(auth, attemptId, true);
    throw conflict('Your time ran out; the paper was submitted automatically.');
  }

  const testQuestion = await prisma.testQuestion.findFirst({
    where: { id: input.testQuestionId, testId: attempt.testId },
    select: { id: true },
  });

  if (!testQuestion) throw unprocessable('That question is not part of this test.');

  return prisma.testAnswer.upsert({
    where: {
      attemptId_testQuestionId: { attemptId, testQuestionId: input.testQuestionId },
    },
    update: {
      responseText: input.responseText ?? null,
      selectedOption: (input.selectedOption ?? undefined) as Prisma.InputJsonValue | undefined,
      inputMode: input.inputMode,
      ...(input.timeTakenSec !== undefined ? { timeTakenSec: input.timeTakenSec } : {}),
    },
    create: {
      attemptId,
      testQuestionId: input.testQuestionId,
      responseText: input.responseText ?? null,
      selectedOption: (input.selectedOption ?? undefined) as Prisma.InputJsonValue | undefined,
      inputMode: input.inputMode,
      timeTakenSec: input.timeTakenSec ?? null,
    },
    select: { id: true, testQuestionId: true, updatedAt: true },
  });
}

export interface SubmitReport {
  attemptId: string;
  score: number;
  maxMarks: number;
  percentage: number;
  isPassed: boolean | null;
  autoGraded: number;
  awaitingReview: number;
  isProvisional: boolean;
}

/**
 * Submits and auto-marks in one pass.
 *
 * Everything objectively markable is marked immediately, so a student sees
 * their MCQ score straight away. Written answers stay unmarked and the total is
 * flagged provisional until a teacher or the evaluator has read them.
 */
export async function submitAttempt(
  auth: AuthContext,
  attemptId: string,
  autoSubmitted = false,
): Promise<SubmitReport> {
  const attempt = await loadOwnAttempt(auth, attemptId);

  if (attempt.status === AttemptStatus.EVALUATED || attempt.status === AttemptStatus.SUBMITTED) {
    throw conflict('This attempt has already been submitted.');
  }

  const options = await loadTestConfig(attempt.testId);

  const rows = await prisma.testQuestion.findMany({
    where: { testId: attempt.testId },
    select: {
      id: true,
      marks: true,
      question: {
        select: { id: true, type: true, marks: true, correctAnswer: true, markingScheme: true },
      },
    },
  });

  const answers = await prisma.testAnswer.findMany({
    where: { attemptId },
    select: { id: true, testQuestionId: true, responseText: true, selectedOption: true },
  });

  const answerByQuestion = new Map(answers.map((a) => [a.testQuestionId, a]));

  const gradable: GradableQuestion[] = rows.map((row) => {
    const scheme = unpackScheme(row.question.markingScheme);
    return {
      id: row.id,
      type: row.question.type as GradableType,
      marks: row.marks ?? row.question.marks,
      correctAnswer: row.question.correctAnswer,
      ...(scheme.tolerance !== undefined ? { tolerance: scheme.tolerance } : {}),
      ...(scheme.toleranceIsRelative !== undefined
        ? { toleranceIsRelative: scheme.toleranceIsRelative }
        : {}),
    };
  });

  const results: GradeResult[] = gradable.map((question) => {
    const answer = answerByQuestion.get(question.id);
    return gradeAnswer(
      question,
      { responseText: answer?.responseText, selectedOption: answer?.selectedOption },
      options,
    );
  });

  const summary = scoreAttempt(results, gradable, attempt.test.passingMarks);

  const timeTakenSec = attempt.startedAt
    ? Math.round((Date.now() - attempt.startedAt.getTime()) / 1000)
    : null;

  await prisma.$transaction([
    ...results
      .filter((result) => answerByQuestion.has(result.questionId))
      .map((result) =>
        prisma.testAnswer.update({
          where: { id: answerByQuestion.get(result.questionId)?.id ?? '' },
          data: { marksAwarded: result.marksAwarded, isCorrect: result.isCorrect },
        }),
      ),
    prisma.testAttempt.update({
      where: { id: attemptId },
      data: {
        status: summary.isProvisional ? AttemptStatus.SUBMITTED : AttemptStatus.EVALUATED,
        submittedAt: new Date(),
        evaluatedAt: summary.isProvisional ? null : new Date(),
        timeTakenSec,
        score: summary.score,
        percentage: summary.percentage,
        isPassed: summary.isPassed,
        teacherRemark: autoSubmitted ? 'Submitted automatically when time ran out.' : null,
      },
    }),
  ]);

  return { attemptId, ...summary };
}

/** A teacher marking one written answer by hand. */
export async function gradeWrittenAnswer(
  auth: AuthContext,
  answerId: string,
  marksAwarded: number,
) {
  const answer = await prisma.testAnswer.findFirst({
    where: {
      id: answerId,
      attempt: { test: { batch: { classGroup: { instituteId: auth.instituteId } } } },
    },
    select: {
      id: true,
      attemptId: true,
      marksAwarded: true,
      testQuestion: {
        select: { marks: true, question: { select: { marks: true } }, test: { select: { teacherId: true } } },
      },
    },
  });

  if (!answer) throw notFound('Answer');

  if (auth.role === Role.TEACHER && answer.testQuestion.test.teacherId !== auth.profileId) {
    throw forbidden('You can only mark your own test.');
  }

  const ceiling = answer.testQuestion.marks ?? answer.testQuestion.question.marks;
  if (marksAwarded > ceiling) {
    throw unprocessable(`That question is worth ${ceiling} marks.`);
  }

  await prisma.testAnswer.update({
    where: { id: answerId },
    data: { marksAwarded, isCorrect: marksAwarded >= ceiling * 0.5 },
  });

  return retotalAttempt(answer.attemptId);
}

/** Recomputes an attempt from its answers. Called after any manual mark. */
export async function retotalAttempt(attemptId: string) {
  const attempt = await prisma.testAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: { id: true, testId: true, test: { select: { passingMarks: true } } },
  });

  const rows = await prisma.testQuestion.findMany({
    where: { testId: attempt.testId },
    select: { id: true, marks: true, question: { select: { marks: true, type: true } } },
  });

  const answers = await prisma.testAnswer.findMany({
    where: { attemptId },
    select: { testQuestionId: true, marksAwarded: true, isCorrect: true },
  });

  const byQuestion = new Map(answers.map((a) => [a.testQuestionId, a]));

  const gradable: GradableQuestion[] = rows.map((row) => ({
    id: row.id,
    type: row.question.type as GradableType,
    marks: row.marks ?? row.question.marks,
    correctAnswer: null,
  }));

  const results: GradeResult[] = rows.map((row) => {
    const answer = byQuestion.get(row.id);
    return {
      questionId: row.id,
      isCorrect: answer?.isCorrect ?? null,
      marksAwarded: answer?.marksAwarded ?? null,
      needsManualReview: answer?.marksAwarded === null || answer?.marksAwarded === undefined,
      note: '',
    };
  });

  const summary = scoreAttempt(results, gradable, attempt.test.passingMarks);

  return prisma.testAttempt.update({
    where: { id: attemptId },
    data: {
      score: summary.score,
      percentage: summary.percentage,
      isPassed: summary.isPassed,
      status: summary.isProvisional ? AttemptStatus.SUBMITTED : AttemptStatus.EVALUATED,
      evaluatedAt: summary.isProvisional ? null : new Date(),
    },
    select: { id: true, score: true, percentage: true, isPassed: true, status: true },
  });
}

/**
 * Ranks the cohort and opens the results to students.
 *
 * Refused while anything is unmarked: publishing a leaderboard built on
 * half-marked papers would rank students on how many MCQs their paper happened
 * to contain.
 */
export async function publishResults(auth: AuthContext, testId: string) {
  const test = await loadEditableTest(auth, testId);

  const attempts = await prisma.testAttempt.findMany({
    where: { testId, status: { in: [AttemptStatus.SUBMITTED, AttemptStatus.EVALUATED] } },
    select: { id: true, score: true, status: true },
  });

  if (attempts.length === 0) throw unprocessable('Nobody has attempted this test yet.');

  const unmarked = attempts.filter((a) => a.status !== AttemptStatus.EVALUATED);
  if (unmarked.length > 0) {
    throw unprocessable(
      `${unmarked.length} attempt(s) still have written answers awaiting marks.`,
    );
  }

  const ranked = rankAttempts(
    attempts.map((a) => ({ attemptId: a.id, score: a.score ?? 0 })),
  );

  await prisma.$transaction([
    ...ranked.map((row) =>
      prisma.testAttempt.update({ where: { id: row.attemptId }, data: { rank: row.rank } }),
    ),
    prisma.test.update({ where: { id: testId }, data: { resultsPublished: true } }),
  ]);

  return { published: ranked.length, topScore: ranked[0]?.score ?? 0, testId: test.id };
}

/** A student's own result, withheld until the teacher publishes. */
export async function attemptResult(auth: AuthContext, attemptId: string) {
  const attempt = await prisma.testAttempt.findFirst({
    where: { id: attemptId, student: studentVisibilityFilter(auth) },
    select: {
      id: true,
      status: true,
      score: true,
      percentage: true,
      rank: true,
      isPassed: true,
      timeTakenSec: true,
      submittedAt: true,
      teacherRemark: true,
      test: {
        select: {
          id: true,
          title: true,
          maxMarks: true,
          passingMarks: true,
          resultsPublished: true,
          teacherId: true,
          subject: { select: { name: true } },
        },
      },
      answers: {
        select: {
          id: true,
          marksAwarded: true,
          isCorrect: true,
          responseText: true,
          selectedOption: true,
          testQuestion: {
            select: {
              orderIndex: true,
              marks: true,
              question: {
                select: { id: true, body: true, type: true, marks: true, explanation: true, topic: { select: { id: true, name: true } } },
              },
            },
          },
        },
        orderBy: { testQuestion: { orderIndex: 'asc' } },
      },
    },
  });

  if (!attempt) throw notFound('Attempt');

  const isStaff = auth.role === Role.TEACHER || auth.role === Role.ADMIN;

  if (!attempt.test.resultsPublished && !isStaff) {
    return {
      testId: attempt.test.id,
      title: attempt.test.title,
      status: attempt.status,
      submittedAt: attempt.submittedAt,
      resultsPublished: false,
      message: 'Your paper has been received. Results appear once your teacher publishes them.',
    };
  }

  return { ...attempt, resultsPublished: true };
}
