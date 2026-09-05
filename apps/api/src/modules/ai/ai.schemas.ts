import { AiTaskStatus, AnswerInputMode, Difficulty, PracticeStatus, TaskMode } from '@prisma/client';
import { z } from 'zod';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form YYYY-MM-DD');

export const generateTaskSchema = z
  .object({
    classSessionId: z.string().uuid().optional(),
    dailyLogId: z.string().uuid().optional(),
    batchId: z.string().uuid(),
    subjectId: z.string().uuid(),
    topicId: z.string().uuid().optional(),
    targetDate: dateString,
    questionCount: z.coerce.number().int().min(1).max(20).default(8),
    difficulty: z.nativeEnum(Difficulty).default(Difficulty.MEDIUM),
    mode: z.nativeEnum(TaskMode).default(TaskMode.BOTH),
    instructions: z.string().trim().max(1000).optional(),
  })
  .refine((value) => value.classSessionId ?? value.dailyLogId, {
    message: 'Give either a classSessionId or a dailyLogId; the questions come from the lecture log.',
  });

export const listTasksSchema = z.object({
  batchId: z.string().uuid().optional(),
  status: z.nativeEnum(AiTaskStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const approveTaskSchema = z.object({
  approvedQuestionIds: z.array(z.string().uuid()).min(1).max(50),
});

export const rejectTaskSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const evaluateSchema = z.object({
  target: z.enum(['practiceAnswer', 'testAnswer', 'assignmentSubmission']),
  id: z.string().uuid(),
});

export const overrideSchema = z.object({
  score: z.coerce.number().min(0),
  reason: z.string().trim().min(3).max(500),
  teacherRemarks: z.string().trim().max(2000).optional(),
});

export const retrieveSchema = z.object({
  query: z.string().trim().min(3).max(1000),
  subjectId: z.string().uuid().optional(),
  topicId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
});

export const buildPracticeSchema = z.object({
  studentId: z.string().uuid().optional(),
  aiTaskId: z.string().uuid(),
  selfStudySessionId: z.string().uuid().optional(),
  taskNumber: z.coerce.number().int().min(1).max(4).default(1),
  questionCount: z.coerce.number().int().min(1).max(20).optional(),
});

export const practiceAnswerSchema = z.object({
  responseText: z.string().max(20_000).nullable().optional(),
  selectedOption: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  inputMode: z.nativeEnum(AnswerInputMode).default(AnswerInputMode.DIGITAL_TEXT),
  timeTakenSec: z.coerce.number().int().min(0).max(36_000).optional(),
});

export const listPracticeSchema = z.object({
  studentId: z.string().uuid().optional(),
  status: z.nativeEnum(PracticeStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
