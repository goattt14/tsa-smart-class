import { Difficulty, QuestionSource, QuestionType } from '@prisma/client';
import { z } from 'zod';
import { paginationSchema } from '../../lib/pagination';

export const listQuestionsSchema = paginationSchema.extend({
  subjectId: z.string().uuid().optional(),
  topicId: z.string().uuid().optional(),
  type: z.nativeEnum(QuestionType).optional(),
  difficulty: z.nativeEnum(Difficulty).optional(),
  source: z.nativeEnum(QuestionSource).optional(),
  isApproved: z.coerce.boolean().optional(),
});

const optionSchema = z.object({
  id: z.string().trim().min(1).max(8),
  text: z.string().trim().min(1).max(600),
});

export const questionBodySchema = z
  .object({
    subjectId: z.string().uuid(),
    topicId: z.string().uuid().nullable().optional(),
    type: z.nativeEnum(QuestionType),
    difficulty: z.nativeEnum(Difficulty).default(Difficulty.MEDIUM),
    body: z.string().trim().min(5).max(4000),
    options: z.array(optionSchema).min(2).max(8).optional(),
    correctAnswer: z.union([z.string(), z.array(z.string()), z.number()]).nullable().optional(),
    modelAnswer: z.string().trim().max(6000).optional(),
    explanation: z.string().trim().max(4000).optional(),
    markingScheme: z
      .array(z.object({ step: z.string().trim().min(1).max(500), marks: z.number().min(0) }))
      .max(20)
      .optional(),
    marks: z.coerce.number().min(0.25).max(100).default(1),
    expectedTimeSec: z.coerce.number().int().min(10).max(3600).default(120),
    bloomLevel: z.string().trim().max(40).optional(),
    tolerance: z.coerce.number().min(0).optional(),
    toleranceIsRelative: z.boolean().optional(),
    isApproved: z.boolean().default(false),
  })
  /**
   * The shape rules live in the schema rather than the service, so a malformed
   * question is rejected at the door instead of failing silently at grading
   * time when a student is sitting in front of it.
   */
  .superRefine((value, ctx) => {
    const needsOptions =
      value.type === QuestionType.MCQ_SINGLE || value.type === QuestionType.MCQ_MULTI;

    if (needsOptions) {
      if (!value.options || value.options.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options'],
          message: 'A multiple-choice question needs at least two options.',
        });
        return;
      }

      const ids = value.options.map((o) => o.id);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options'],
          message: 'Option ids must be unique.',
        });
      }

      const answers =
        value.correctAnswer === null || value.correctAnswer === undefined
          ? []
          : Array.isArray(value.correctAnswer)
            ? value.correctAnswer
            : [String(value.correctAnswer)];

      if (answers.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['correctAnswer'],
          message: 'Mark which option is correct.',
        });
      }

      for (const answer of answers) {
        if (!ids.includes(String(answer))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['correctAnswer'],
            message: `"${answer}" is not one of the option ids.`,
          });
        }
      }

      if (value.type === QuestionType.MCQ_SINGLE && answers.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['correctAnswer'],
          message: 'A single-answer question can have only one correct option.',
        });
      }
    }

    if (value.type === QuestionType.NUMERICAL) {
      const numeric =
        typeof value.correctAnswer === 'number' ||
        (typeof value.correctAnswer === 'string' && value.correctAnswer.trim() !== '' &&
          Number.isFinite(Number(value.correctAnswer)));

      if (!numeric) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['correctAnswer'],
          message: 'A numerical question needs a numeric answer.',
        });
      }
    }

    if (value.type === QuestionType.FILL_BLANK) {
      const answers = Array.isArray(value.correctAnswer)
        ? value.correctAnswer
        : value.correctAnswer
          ? [String(value.correctAnswer)]
          : [];

      if (answers.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['correctAnswer'],
          message: 'List at least one accepted answer for the blank.',
        });
      }
    }

    const written =
      value.type === QuestionType.SHORT_ANSWER ||
      value.type === QuestionType.LONG_ANSWER ||
      value.type === QuestionType.VIVA_ORAL;

    if (written && !value.modelAnswer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelAnswer'],
        message: 'A written question needs a model answer; the evaluator marks against it.',
      });
    }
  });

export const updateQuestionSchema = z.object({
  topicId: z.string().uuid().nullable().optional(),
  difficulty: z.nativeEnum(Difficulty).optional(),
  body: z.string().trim().min(5).max(4000).optional(),
  options: z.array(optionSchema).min(2).max(8).optional(),
  correctAnswer: z.union([z.string(), z.array(z.string()), z.number()]).nullable().optional(),
  modelAnswer: z.string().trim().max(6000).nullable().optional(),
  explanation: z.string().trim().max(4000).nullable().optional(),
  marks: z.coerce.number().min(0.25).max(100).optional(),
  expectedTimeSec: z.coerce.number().int().min(10).max(3600).optional(),
  isApproved: z.boolean().optional(),
});

export const bulkImportSchema = z.object({
  questions: z.array(questionBodySchema).min(1).max(200),
});
