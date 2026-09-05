import {
  AiFeature,
  AiProviderName,
  AiTaskStatus,
  Difficulty,
  Prisma,
  QuestionSource,
  QuestionType,
  Role,
  TaskMode,
} from '@prisma/client';
import { parseModelJson, validateGeneratedQuestions } from '../../ai/parsing';
import { buildTaskGenerationPrompt, PROMPT_VERSION, type SourcePassage } from '../../ai/prompts';
import { complete } from '../../ai/router';
import { forbidden, notFound, unprocessable } from '../../lib/http-error';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { toUtcDate } from '../../lib/time';
import type { AuthContext } from '../../types/express';
import { retrievePassages } from './rag.service';

function providerEnum(name: string): AiProviderName {
  const upper = name.toUpperCase();
  return (Object.values(AiProviderName) as string[]).includes(upper)
    ? (upper as AiProviderName)
    : AiProviderName.MOCK;
}

export interface GenerateInput {
  classSessionId?: string | undefined;
  dailyLogId?: string | undefined;
  batchId: string;
  subjectId: string;
  topicId?: string | undefined;
  targetDate: string;
  questionCount: number;
  difficulty: Difficulty;
  mode: TaskMode;
  instructions?: string | undefined;
}

export async function generateTask(auth: AuthContext, input: GenerateInput) {
  const [batch, subject] = await Promise.all([
    prisma.batch.findFirst({
      where: { id: input.batchId, classGroup: { instituteId: auth.instituteId } },
      select: { id: true, name: true, classGroup: { select: { gradeLevel: true } } },
    }),
    prisma.subject.findFirst({
      where: { id: input.subjectId, instituteId: auth.instituteId, deletedAt: null },
      select: { id: true, name: true },
    }),
  ]);

  if (!batch) throw notFound('Batch');
  if (!subject) throw notFound('Subject');

  const dailyLog = input.dailyLogId
    ? await prisma.teacherDailyLog.findUnique({
        where: { id: input.dailyLogId },
        select: { id: true, topic: true, description: true, keyPoints: true },
      })
    : input.classSessionId
      ? await prisma.teacherDailyLog.findUnique({
          where: { classSessionId: input.classSessionId },
          select: { id: true, topic: true, description: true, keyPoints: true },
        })
      : null;

  if (!dailyLog) {
    throw unprocessable(
      'No daily log exists for that lecture. File the log first; the questions are generated from it.',
    );
  }

  const keyPoints = Array.isArray(dailyLog.keyPoints) ? (dailyLog.keyPoints as string[]) : [];

  const task = await prisma.aiTask.create({
    data: {
      batchId: input.batchId,
      subjectId: input.subjectId,
      topicId: input.topicId ?? null,
      classSessionId: input.classSessionId ?? null,
      dailyLogId: dailyLog.id,
      title: `${subject.name}: ${dailyLog.topic}`,
      mode: input.mode,
      status: AiTaskStatus.GENERATING,
      targetDate: toUtcDate(input.targetDate),
      instructions: input.instructions ?? null,
      questionCount: input.questionCount,
      baseDifficulty: input.difficulty,
      promptVersion: PROMPT_VERSION,
    },
    select: { id: true },
  });

  try {
    const query = [dailyLog.topic, dailyLog.description, ...keyPoints]
      .filter(Boolean)
      .join(' ')
      .slice(0, 1500);

    const retrieval = await retrievePassages(
      query,
      { subjectId: input.subjectId, topicId: input.topicId, batchId: input.batchId },
      auth.instituteId,
    );

    if (retrieval.chunks.length === 0) {
      await prisma.aiTask.update({
        where: { id: task.id },
        data: {
          status: AiTaskStatus.FAILED,
          generationError:
            'No indexed teacher material matched this lecture. Upload and index material for this topic first.',
        },
      });
      throw unprocessable(
        'No indexed material matched this lecture, so there is nothing to ground the questions in. Upload the notes for this topic and index them first.',
      );
    }

    const passages: SourcePassage[] = retrieval.chunks.map((chunk, index) => ({
      index: index + 1,
      content: chunk.content,
      sectionTitle: chunk.sectionTitle,
    }));

    const prompt = buildTaskGenerationPrompt({
      subject: subject.name,
      topic: dailyLog.topic,
      gradeLevel: batch.classGroup.gradeLevel,
      lectureSummary: dailyLog.description,
      keyPoints,
      questionCount: input.questionCount,
      difficulty: input.difficulty,
      passages,
    });

    const response = await complete(
      {
        feature: AiFeature.TASK_GENERATION,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        json: true,
        temperature: 0.5,
      },
      { userId: auth.userId },
    );

    const parsed = parseModelJson<{ questions: unknown[] }>(response.text);

    if (!parsed.ok) {
      throw new Error(`The model did not return usable JSON: ${parsed.reason}`);
    }

    const validation = validateGeneratedQuestions(parsed.value?.questions ?? parsed.value ?? [], passages.length);

    if (validation.accepted.length === 0) {
      throw new Error(
        `Every generated question was rejected: ${validation.rejected
          .slice(0, 3)
          .map((r) => r.reason)
          .join('; ')}`,
      );
    }

    const chunkIdByIndex = new Map(
      retrieval.chunks.map((chunk, index) => [index + 1, chunk.chunkId]),
    );

    for (const question of validation.accepted) {
      const sourceChunkIds = (question.sourcePassages ?? [])
        .map((idx) => chunkIdByIndex.get(idx))
        .filter((id): id is string => Boolean(id));

      await prisma.question.create({
        data: {
          subjectId: input.subjectId,
          topicId: input.topicId ?? null,
          aiTaskId: task.id,
          createdById: auth.userId,
          type: question.type as QuestionType,
          difficulty: question.difficulty as Difficulty,
          source: QuestionSource.AI_GENERATED,
          body: question.body,
          options: (question.options ?? undefined) as Prisma.InputJsonValue | undefined,
          correctAnswer: (question.correctAnswer ?? undefined) as Prisma.InputJsonValue | undefined,
          modelAnswer: question.modelAnswer ?? null,
          explanation: question.explanation ?? null,
          marks: question.marks,
          expectedTimeSec: (question as any).expectedTimeSec ?? 120,
          sourceChunkIds: sourceChunkIds as unknown as Prisma.InputJsonValue,
          isApproved: false,
        },
      });
    }

    const updated = await prisma.aiTask.update({
      where: { id: task.id },
      data: {
        status: AiTaskStatus.PENDING_REVIEW,
        provider: providerEnum(response.provider),
        model: response.model,
        generationError:
          validation.rejected.length > 0
            ? `${validation.rejected.length} question(s) were rejected by validation.`
            : null,
      },
      select: { id: true, title: true, status: true },
    });

    return {
      task: updated,
      generated: validation.accepted.length,
      rejected: validation.rejected,
      grounding: {
        passagesUsed: passages.length,
        degraded: retrieval.degraded,
      },
      provider: response.provider,
      model: response.model,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown generation error';
    await prisma.aiTask.update({
      where: { id: task.id },
      data: { status: AiTaskStatus.FAILED, generationError: message.slice(0, 500) },
    });
    logger.error({ err: error, taskId: task.id }, 'task generation failed');
    throw error;
  }
}

export async function listTasks(
  auth: AuthContext,
  args: { batchId?: string | undefined; status?: AiTaskStatus | undefined; limit: number },
) {
  return prisma.aiTask.findMany({
    where: {
      batch: { classGroup: { instituteId: auth.instituteId } },
      ...(args.batchId ? { batchId: args.batchId } : {}),
      ...(args.status ? { status: args.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: args.limit,
    select: {
      id: true,
      title: true,
      status: true,
      mode: true,
      targetDate: true,
      questionCount: true,
      baseDifficulty: true,
      provider: true,
      model: true,
      generationError: true,
      reviewedAt: true,
      publishedAt: true,
      createdAt: true,
      batch: { select: { id: true, name: true } },
      subject: { select: { id: true, name: true, colorHex: true } },
      _count: { select: { questions: true } },
    },
  });
}

export async function taskForReview(auth: AuthContext, taskId: string) {
  const task = await prisma.aiTask.findFirst({
    where: { id: taskId, batch: { classGroup: { instituteId: auth.instituteId } } },
    select: {
      id: true,
      title: true,
      status: true,
      generationError: true,
      provider: true,
      model: true,
      promptVersion: true,
      dailyLog: { select: { topic: true, description: true, keyPoints: true } },
      questions: {
        where: { deletedAt: null },
        select: {
          id: true,
          type: true,
          difficulty: true,
          body: true,
          options: true,
          correctAnswer: true,
          modelAnswer: true,
          explanation: true,
          marks: true,
          isApproved: true,
          sourceChunkIds: true,
        },
      },
    },
  });

  if (!task) throw notFound('AI task');

  const chunkIds = task.questions.flatMap((q) =>
    Array.isArray(q.sourceChunkIds) ? (q.sourceChunkIds as string[]) : [],
  );

  const chunks =
    chunkIds.length > 0
      ? await prisma.materialChunk.findMany({
          where: { id: { in: [...new Set(chunkIds)] } },
          select: {
            id: true,
            content: true,
            sectionTitle: true,
            material: { select: { id: true, title: true } },
          },
        })
      : [];

  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));

  return {
    ...task,
    questions: task.questions.map((question) => ({
      ...question,
      sources: (Array.isArray(question.sourceChunkIds) ? (question.sourceChunkIds as string[]) : [])
        .map((id) => chunkById.get(id))
        .filter(Boolean),
    })),
  };
}

export async function approveTask(auth: AuthContext, taskId: string, questionIds: string[]) {
  const task = await prisma.aiTask.findFirst({
    where: { id: taskId, batch: { classGroup: { instituteId: auth.instituteId } } },
    select: { id: true, status: true, questions: { where: { deletedAt: null }, select: { id: true } } },
  });

  if (!task) throw notFound('AI task');
  if (auth.role !== Role.TEACHER && auth.role !== Role.ADMIN) {
    throw forbidden('Only a teacher or administrator can approve generated questions.');
  }

  const approved = new Set(questionIds);
  const all = task.questions.map((q) => q.id);
  const rejected = all.filter((id) => !approved.has(id));

  if (approved.size === 0) {
    throw unprocessable('Approve at least one question, or reject the whole task.');
  }

  await prisma.$transaction([
    prisma.question.updateMany({
      where: { id: { in: [...approved] }, aiTaskId: taskId },
      data: { isApproved: true, source: QuestionSource.AI_EDITED_BY_TEACHER },
    }),
    ...(rejected.length > 0
      ? [
          prisma.question.updateMany({
            where: { id: { in: rejected }, aiTaskId: taskId },
            data: { deletedAt: new Date() },
          }),
        ]
      : []),
    prisma.aiTask.update({
      where: { id: taskId },
      data: {
        status: AiTaskStatus.PUBLISHED,
        reviewedById: auth.userId,
        reviewedAt: new Date(),
        publishedAt: new Date(),
      },
    }),
  ]);

  return { taskId, approved: approved.size, discarded: rejected.length };
}

export async function rejectTask(auth: AuthContext, taskId: string, reason: string) {
  const task = await prisma.aiTask.findFirst({
    where: { id: taskId, batch: { classGroup: { instituteId: auth.instituteId } } },
    select: { id: true },
  });
  if (!task) throw notFound('AI task');
  await prisma.$transaction([
    prisma.question.updateMany({
      where: { aiTaskId: taskId },
      data: { deletedAt: new Date() },
    }),
    prisma.aiTask.update({
      where: { id: taskId },
      data: {
        status: AiTaskStatus.REJECTED,
        reviewedById: auth.userId,
        reviewedAt: new Date(),
        generationError: reason.slice(0, 500),
      },
    }),
  ]);
  return { taskId, rejected: true };
}
