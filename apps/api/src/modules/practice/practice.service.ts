import { AnswerInputMode, Difficulty, PracticeStatus, Prisma, Role } from '@prisma/client';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/http-error';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { studentVisibilityFilter } from '../../lib/scope';
import { recommendDifficulty, INITIAL_MASTERY } from '../performance/mastery';
import { evaluateAnswer } from '../ai/evaluation.service';
import type { AuthContext } from '../../types/express';

/**
 * Builds a practice set for one student from an approved AI task.
 *
 * Difficulty is chosen per student from their topic mastery rather than fixed
 * for the batch, which is what makes the task personalised in practice and not
 * just in the marketing.
 */
export async function buildPracticeSession(
  auth: AuthContext,
  input: {
    studentId: string;
    aiTaskId: string;
    selfStudySessionId?: string | undefined;
    taskNumber: number;
    questionCount?: number | undefined;
  },
) {
  const task = await prisma.aiTask.findFirst({
    where: {
      id: input.aiTaskId,
      status: 'PUBLISHED',
      batch: { classGroup: { instituteId: auth.instituteId } },
    },
    select: {
      id: true,
      subjectId: true,
      topicId: true,
      questionCount: true,
      questions: {
        where: { deletedAt: null, isApproved: true },
        select: { id: true, difficulty: true, marks: true, topicId: true },
      },
    },
  });

  if (!task) throw notFound('Published AI task');

  if (task.questions.length === 0) {
    throw unprocessable('That task has no approved questions yet.');
  }

  // Mastery on this topic decides how hard the set should be for this student.
  const mastery = task.topicId
    ? await prisma.topicMastery.findUnique({
        where: { studentId_topicId: { studentId: input.studentId, topicId: task.topicId } },
        select: { score: true, attempts: true, consecutiveRight: true },
      })
    : null;

  const targetDifficulty = recommendDifficulty({
    ...INITIAL_MASTERY,
    score: mastery?.score ?? 0,
    attempts: mastery?.attempts ?? 0,
    consecutiveRight: mastery?.consecutiveRight ?? 0,
  });

  const ladder: Difficulty[] = ['VERY_EASY', 'EASY', 'MEDIUM', 'HARD', 'VERY_HARD'];
  const targetIndex = ladder.indexOf(targetDifficulty as Difficulty);

  // Sorted by distance from the target, so the set centres on the right level
  // and widens outwards only when there are not enough questions at it.
  const ordered = [...task.questions].sort((a, b) => {
    const da = Math.abs(ladder.indexOf(a.difficulty) - targetIndex);
    const db = Math.abs(ladder.indexOf(b.difficulty) - targetIndex);
    return da - db;
  });

  const wanted = input.questionCount ?? Math.min(task.questionCount, ordered.length);
  const chosen = ordered.slice(0, wanted);

  const existing = await prisma.practiceSession.findFirst({
    where: {
      studentId: input.studentId,
      aiTaskId: input.aiTaskId,
      taskNumber: input.taskNumber,
    },
    select: { id: true },
  });

  if (existing) return { practiceSessionId: existing.id, questionCount: chosen.length, reused: true };

  const session = await prisma.practiceSession.create({
    data: {
      studentId: input.studentId,
      aiTaskId: input.aiTaskId,
      selfStudySessionId: input.selfStudySessionId ?? null,
      subjectId: task.subjectId,
      taskNumber: input.taskNumber,
      difficultyUsed: targetDifficulty as Difficulty,
      maxScore: chosen.reduce((sum, q) => sum + q.marks, 0),
      questions: {
        create: chosen.map((question, index) => ({
          questionId: question.id,
          orderIndex: index,
          difficulty: question.difficulty,
          marks: question.marks,
        })),
      },
    },
    select: { id: true },
  });

  return {
    practiceSessionId: session.id,
    questionCount: chosen.length,
    difficulty: targetDifficulty,
    reused: false,
  };
}

async function loadOwnSession(auth: AuthContext, sessionId: string) {
  const session = await prisma.practiceSession.findFirst({
    where: { id: sessionId, student: studentVisibilityFilter(auth) },
    select: {
      id: true,
      studentId: true,
      status: true,
      startedAt: true,
      focusMin: true,
      maxScore: true,
    },
  });

  if (!session) throw notFound('Practice session');

  if (auth.role === Role.STUDENT && session.studentId !== auth.profileId) {
    throw forbidden('That is not your practice session.');
  }

  return session;
}

/** The question set as the student sees it: no answer keys. */
export async function loadPractice(auth: AuthContext, sessionId: string) {
  const session = await loadOwnSession(auth, sessionId);

  const questions = await prisma.practiceQuestion.findMany({
    where: { practiceSessionId: sessionId },
    orderBy: { orderIndex: 'asc' },
    select: {
      id: true,
      orderIndex: true,
      marks: true,
      difficulty: true,
      question: {
        select: { id: true, type: true, body: true, options: true, expectedTimeSec: true },
      },
      answer: {
        select: {
          id: true,
          responseText: true,
          selectedOption: true,
          timeTakenSec: true,
          evaluation: {
            select: {
              score: true,
              maxScore: true,
              verdict: true,
              whatWentRight: true,
              whatWentWrong: true,
              whyItWentWrong: true,
              correctApproach: true,
              improvementTip: true,
              source: true,
            },
          },
        },
      },
    },
  });

  return { session, questions };
}

export async function startPractice(auth: AuthContext, sessionId: string) {
  const session = await loadOwnSession(auth, sessionId);

  if (session.status === PracticeStatus.EVALUATED) {
    throw conflict('That practice set is already finished.');
  }

  return prisma.practiceSession.update({
    where: { id: sessionId },
    data: {
      status: PracticeStatus.IN_PROGRESS,
      startedAt: session.startedAt ?? new Date(),
    },
  });
}

export async function savePracticeAnswer(
  auth: AuthContext,
  practiceQuestionId: string,
  input: {
    responseText?: string | null | undefined;
    selectedOption?: string | string[] | null | undefined;
    inputMode: AnswerInputMode;
    timeTakenSec?: number | undefined;
  },
) {
  const question = await prisma.practiceQuestion.findFirst({
    where: {
      id: practiceQuestionId,
      practiceSession: { student: studentVisibilityFilter(auth) },
    },
    select: {
      id: true,
      practiceSession: { select: { id: true, studentId: true, status: true } },
    },
  });

  if (!question) throw notFound('Practice question');

  if (auth.role === Role.STUDENT && question.practiceSession.studentId !== auth.profileId) {
    throw forbidden('That is not your practice question.');
  }

  if (question.practiceSession.status === PracticeStatus.EVALUATED) {
    throw conflict('That practice set has already been marked.');
  }

  return prisma.practiceAnswer.upsert({
    where: { practiceQuestionId },
    update: {
      responseText: input.responseText ?? null,
      selectedOption: (input.selectedOption ?? undefined) as Prisma.InputJsonValue | undefined,
      inputMode: input.inputMode,
      ...(input.timeTakenSec !== undefined ? { timeTakenSec: input.timeTakenSec } : {}),
      submittedAt: new Date(),
    },
    create: {
      practiceQuestionId,
      responseText: input.responseText ?? null,
      selectedOption: (input.selectedOption ?? undefined) as Prisma.InputJsonValue | undefined,
      inputMode: input.inputMode,
      timeTakenSec: input.timeTakenSec ?? null,
    },
    select: { id: true, submittedAt: true },
  });
}

export interface PracticeReport {
  practiceSessionId: string;
  evaluated: number;
  failed: number;
  totalScore: number;
  maxScore: number;
  accuracyPct: number;
  pending: string[];
}

/**
 * Submits the set and evaluates every answer.
 *
 * Evaluated one at a time rather than in a single batch call: a failure on one
 * answer must not cost the student the marks on the other seven. Anything that
 * fails is listed as pending for a teacher rather than scored zero.
 */
export async function submitPractice(
  auth: AuthContext,
  sessionId: string,
): Promise<PracticeReport> {
  const session = await loadOwnSession(auth, sessionId);

  if (session.status === PracticeStatus.EVALUATED) {
    throw conflict('That practice set has already been marked.');
  }

  await prisma.practiceSession.update({
    where: { id: sessionId },
    data: { status: PracticeStatus.EVALUATING, submittedAt: new Date() },
  });

  const answers = await prisma.practiceAnswer.findMany({
    where: { practiceQuestion: { practiceSessionId: sessionId } },
    select: {
      id: true,
      responseText: true,
      practiceQuestion: { select: { id: true, marks: true, question: { select: { topicId: true, difficulty: true } } } },
    },
  });

  let totalScore = 0;
  let evaluated = 0;
  const pending: string[] = [];

  for (const answer of answers) {
    if ((answer.responseText ?? '').trim().length === 0) {
      pending.push(answer.practiceQuestion.id);
      continue;
    }

    try {
      const result = await evaluateAnswer(auth, { kind: 'practiceAnswer', id: answer.id });
      totalScore += result.score;
      evaluated += 1;

      // Mastery is updated per answer so the next task adapts immediately.
      const topicId = answer.practiceQuestion.question.topicId;
      if (topicId) {
        const { recordOutcome } = await import('../performance/performance.service');
        await recordOutcome(session.studentId, topicId, {
          isCorrect: result.verdict === 'correct',
          creditFraction: result.maxScore > 0 ? result.score / result.maxScore : 0,
          difficulty: answer.practiceQuestion.question.difficulty,
        });
      }
    } catch (error) {
      logger.error({ err: error, answerId: answer.id }, 'practice answer evaluation failed');
      pending.push(answer.practiceQuestion.id);
    }
  }

  const maxScore = session.maxScore ?? 0;
  const accuracyPct = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

  await prisma.practiceSession.update({
    where: { id: sessionId },
    data: {
      // Left in EVALUATING while anything is unmarked, so the UI can show that
      // some answers are still waiting rather than implying a final score.
      status: pending.length > 0 ? PracticeStatus.EVALUATING : PracticeStatus.EVALUATED,
      evaluatedAt: pending.length > 0 ? null : new Date(),
      totalScore,
      accuracyPct,
    },
  });

  return {
    practiceSessionId: sessionId,
    evaluated,
    failed: pending.length,
    totalScore: Math.round(totalScore * 100) / 100,
    maxScore,
    accuracyPct,
    pending,
  };
}

export async function listPractice(
  auth: AuthContext,
  args: { studentId?: string | undefined; status?: PracticeStatus | undefined; limit: number },
) {
  return prisma.practiceSession.findMany({
    where: {
      student: studentVisibilityFilter(auth),
      ...(args.studentId ? { studentId: args.studentId } : {}),
      ...(args.status ? { status: args.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: args.limit,
    select: {
      id: true,
      taskNumber: true,
      status: true,
      difficultyUsed: true,
      totalScore: true,
      maxScore: true,
      accuracyPct: true,
      startedAt: true,
      submittedAt: true,
      evaluatedAt: true,
      subject: { select: { id: true, name: true, colorHex: true } },
      aiTask: { select: { id: true, title: true } },
      _count: { select: { questions: true } },
    },
  });
}
