import { Difficulty, Prisma, QuestionSource, QuestionType, Role } from '@prisma/client';
import { buildPageMeta } from '../../lib/api-response';
import { forbidden, notFound, unprocessable } from '../../lib/http-error';
import { safeOrderBy, toSkipTake } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import type { AuthContext } from '../../types/express';

const SORTS = ['createdAt', 'difficulty', 'marks', 'usageCount', 'correctRate'] as const;

export interface QuestionInput {
  subjectId: string;
  topicId?: string | null | undefined;
  type: QuestionType;
  difficulty: Difficulty;
  body: string;
  options?: { id: string; text: string }[] | undefined;
  correctAnswer?: string | string[] | number | null | undefined;
  modelAnswer?: string | undefined;
  explanation?: string | undefined;
  markingScheme?: { step: string; marks: number }[] | undefined;
  marks: number;
  expectedTimeSec: number;
  bloomLevel?: string | undefined;
  tolerance?: number | undefined;
  toleranceIsRelative?: boolean | undefined;
  isApproved: boolean;
}

/**
 * Numerical tolerance has no column of its own, so it rides inside the
 * markingScheme JSON. Keeping the read and write in one pair of functions means
 * the grading path and the authoring path cannot disagree about the format.
 */
interface SchemeEnvelope {
  steps?: { step: string; marks: number }[];
  tolerance?: number;
  toleranceIsRelative?: boolean;
}

export function packScheme(input: QuestionInput): Prisma.InputJsonValue | undefined {
  const envelope: SchemeEnvelope = {};
  if (input.markingScheme?.length) envelope.steps = input.markingScheme;
  if (input.tolerance !== undefined) envelope.tolerance = input.tolerance;
  if (input.toleranceIsRelative !== undefined) {
    envelope.toleranceIsRelative = input.toleranceIsRelative;
  }
  return Object.keys(envelope).length > 0 ? (envelope as Prisma.InputJsonValue) : undefined;
}

export function unpackScheme(value: unknown): SchemeEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as SchemeEnvelope;
}

export const questionSelect = {
  id: true,
  type: true,
  difficulty: true,
  source: true,
  body: true,
  options: true,
  marks: true,
  expectedTimeSec: true,
  bloomLevel: true,
  isApproved: true,
  usageCount: true,
  correctRate: true,
  createdAt: true,
  subject: { select: { id: true, name: true, colorHex: true } },
  topic: { select: { id: true, name: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.QuestionSelect;

/** Adds the answer key. Never sent to a student mid-attempt. */
export const questionWithAnswerSelect = {
  ...questionSelect,
  correctAnswer: true,
  modelAnswer: true,
  explanation: true,
  markingScheme: true,
} satisfies Prisma.QuestionSelect;

export async function listQuestions(
  auth: AuthContext,
  args: {
    page: number;
    pageSize: number;
    search?: string | undefined;
    sort?: string | undefined;
    order: 'asc' | 'desc';
    subjectId?: string | undefined;
    topicId?: string | undefined;
    type?: QuestionType | undefined;
    difficulty?: Difficulty | undefined;
    source?: QuestionSource | undefined;
    isApproved?: boolean | undefined;
  },
) {
  const where: Prisma.QuestionWhereInput = {
    deletedAt: null,
    subject: { instituteId: auth.instituteId },
    ...(args.subjectId ? { subjectId: args.subjectId } : {}),
    ...(args.topicId ? { topicId: args.topicId } : {}),
    ...(args.type ? { type: args.type } : {}),
    ...(args.difficulty ? { difficulty: args.difficulty } : {}),
    ...(args.source ? { source: args.source } : {}),
    ...(args.isApproved !== undefined ? { isApproved: args.isApproved } : {}),
    ...(args.search ? { body: { contains: args.search, mode: 'insensitive' } } : {}),
  };

  const { skip, take } = toSkipTake(args);

  const [items, total] = await Promise.all([
    prisma.question.findMany({
      where,
      orderBy: safeOrderBy(args.sort, SORTS, 'createdAt', args.order),
      skip,
      take,
      select: questionWithAnswerSelect,
    }),
    prisma.question.count({ where }),
  ]);

  return { items, meta: buildPageMeta(args.page, args.pageSize, total) };
}

async function assertSubjectAndTopic(
  auth: AuthContext,
  subjectId: string,
  topicId?: string | null,
): Promise<void> {
  const subject = await prisma.subject.findFirst({
    where: { id: subjectId, instituteId: auth.instituteId, deletedAt: null },
    select: { id: true },
  });
  if (!subject) throw notFound('Subject');

  if (topicId) {
    const topic = await prisma.topic.findFirst({
      where: { id: topicId, subjectId },
      select: { id: true },
    });
    if (!topic) throw unprocessable('That topic does not belong to the chosen subject.');
  }
}

export async function createQuestion(auth: AuthContext, input: QuestionInput) {
  await assertSubjectAndTopic(auth, input.subjectId, input.topicId);

  const scheme = packScheme(input);

  return prisma.question.create({
    data: {
      subjectId: input.subjectId,
      topicId: input.topicId ?? null,
      createdById: auth.userId,
      type: input.type,
      difficulty: input.difficulty,
      source: QuestionSource.TEACHER,
      body: input.body,
      options: (input.options ?? undefined) as Prisma.InputJsonValue | undefined,
      correctAnswer: (input.correctAnswer ?? undefined) as Prisma.InputJsonValue | undefined,
      modelAnswer: input.modelAnswer || null,
      explanation: input.explanation || null,
      ...(scheme ? { markingScheme: scheme } : {}),
      marks: input.marks,
      expectedTimeSec: input.expectedTimeSec,
      bloomLevel: input.bloomLevel || null,
      // A teacher's own question is trusted; AI-generated ones arrive
      // unapproved in Phase 4 and need a human to sign them off.
      isApproved: input.isApproved,
    },
    select: questionWithAnswerSelect,
  });
}

export async function bulkImport(auth: AuthContext, questions: QuestionInput[]) {
  const created: string[] = [];
  const failed: { index: number; reason: string }[] = [];

  // Sequential rather than a single createMany, so one malformed row reports
  // its own index instead of taking the whole import down.
  for (const [index, question] of questions.entries()) {
    try {
      const record = await createQuestion(auth, question);
      created.push(record.id);
    } catch (error) {
      failed.push({
        index,
        reason: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return { created: created.length, failed, ids: created };
}

export async function updateQuestion(
  auth: AuthContext,
  questionId: string,
  input: Record<string, unknown>,
) {
  const existing = await prisma.question.findFirst({
    where: { id: questionId, deletedAt: null, subject: { instituteId: auth.instituteId } },
    select: { id: true, createdById: true, body: true, source: true, _count: { select: { testQuestions: true } } },
  });

  if (!existing) throw notFound('Question');

  if (auth.role === Role.TEACHER && existing.createdById !== auth.userId) {
    throw forbidden('You can only edit questions you wrote.');
  }

  // Rewriting a question already sitting in a marked test would silently change
  // what students were asked. Cloning keeps the historic paper intact.
  if (existing._count.testQuestions > 0 && typeof input.body === 'string') {
    throw unprocessable(
      'This question is already used in a test. Duplicate it and edit the copy instead.',
    );
  }

  const after = await prisma.question.update({
    where: { id: questionId },
    data: input as Prisma.QuestionUpdateInput,
    select: questionWithAnswerSelect,
  });

  return { before: existing, after };
}

export async function deleteQuestion(auth: AuthContext, questionId: string) {
  const existing = await prisma.question.findFirst({
    where: { id: questionId, deletedAt: null, subject: { instituteId: auth.instituteId } },
    select: { id: true, body: true, createdById: true },
  });

  if (!existing) throw notFound('Question');

  if (auth.role === Role.TEACHER && existing.createdById !== auth.userId) {
    throw forbidden('You can only delete questions you wrote.');
  }

  await prisma.question.update({ where: { id: questionId }, data: { deletedAt: new Date() } });
  return existing;
}

/**
 * Refreshes the rolling correct-rate from real answers.
 *
 * This is what makes the difficulty labels honest over time: a question tagged
 * HARD that 90% of students get right is mislabelled, and the statistic makes
 * that visible instead of leaving the tag to a teacher's first guess.
 */
export async function recalibrateQuestion(questionId: string): Promise<number | null> {
  const stats = await prisma.testAnswer.aggregate({
    where: { testQuestion: { questionId }, isCorrect: { not: null } },
    _count: { _all: true },
  });

  if (stats._count._all < 5) return null;

  const correct = await prisma.testAnswer.count({
    where: { testQuestion: { questionId }, isCorrect: true },
  });

  const rate = correct / stats._count._all;

  await prisma.question.update({
    where: { id: questionId },
    data: { correctRate: rate, usageCount: stats._count._all },
  });

  return rate;
}
