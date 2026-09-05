import { AssignmentKind, SubmissionStatus } from '@prisma/client';
import { z } from 'zod';

export const listHomeworkSchema = z.object({
  batchId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  kind: z.nativeEnum(AssignmentKind).optional(),
  isPublished: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const createHomeworkSchema = z.object({
  batchId: z.string().uuid(),
  subjectId: z.string().uuid(),
  kind: z.nativeEnum(AssignmentKind).default(AssignmentKind.HOMEWORK),
  title: z.string().trim().min(3).max(160),
  instructions: z.string().trim().min(10).max(6000),
  maxMarks: z.coerce.number().min(1).max(200).default(10),
  dueAt: z.coerce.date(),
  allowLate: z.boolean().default(true),
  latePenaltyPct: z.coerce.number().min(0).max(100).default(0),
  publishNow: z.boolean().default(true),
});

export const submitHomeworkSchema = z.object({
  contentText: z.string().max(50_000).optional(),
  asDraft: z.boolean().default(false),
});

export const gradeSubmissionSchema = z.object({
  marksAwarded: z.coerce.number().min(0),
  feedback: z.string().trim().min(1).max(4000),
  status: z.nativeEnum(SubmissionStatus).default(SubmissionStatus.GRADED),
});
