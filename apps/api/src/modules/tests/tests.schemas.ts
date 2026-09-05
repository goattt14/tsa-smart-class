import { AnswerInputMode, TestType } from '@prisma/client';
import { z } from 'zod';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form YYYY-MM-DD');

export const listTestsSchema = z.object({
  batchId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  isPublished: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const createTestSchema = z.object({
  batchId: z.string().uuid(),
  subjectId: z.string().uuid(),
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(2000).optional(),
  type: z.nativeEnum(TestType).default(TestType.UNIT_TEST),
  scheduledAt: z.coerce.date(),
  durationMin: z.coerce.number().int().min(5).max(360).default(60),
  passingPct: z.coerce.number().min(0).max(100).default(35),
  shuffleQuestions: z.boolean().default(true),
  proctoringEnabled: z.boolean().default(false),
  allowLateStartMin: z.coerce.number().int().min(0).max(60).default(10),
  negativeMarkingFraction: z.coerce.number().min(0).max(1).default(0),
});

export const updateTestSchema = createTestSchema
  .omit({ batchId: true, subjectId: true })
  .partial();

export const setQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        questionId: z.string().uuid(),
        marks: z.coerce.number().min(0.25).max(100).optional(),
      }),
    )
    .min(1)
    .max(200),
});

export const saveAnswerSchema = z.object({
  testQuestionId: z.string().uuid(),
  responseText: z.string().max(20_000).nullable().optional(),
  selectedOption: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  inputMode: z.nativeEnum(AnswerInputMode).default(AnswerInputMode.DIGITAL_TEXT),
  timeTakenSec: z.coerce.number().int().min(0).max(36_000).optional(),
});

export const gradeAnswerSchema = z.object({
  marksAwarded: z.coerce.number().min(0),
  feedback: z.string().trim().max(2000).optional(),
});

export const publishResultsSchema = z.object({
  teacherRemarkTemplate: z.string().trim().max(500).optional(),
});
