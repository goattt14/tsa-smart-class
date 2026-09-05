import { Difficulty, ProctoringContext, ProctoringEventType, ProctoringReviewStatus, VivaStatus } from '@prisma/client';
import { z } from 'zod';

export const scheduleVivaSchema = z.object({
  studentId: z.string().uuid().optional(),
  subjectId: z.string().uuid(),
  topicId: z.string().uuid().optional(),
  aiTaskId: z.string().uuid().optional(),
  selfStudySessionId: z.string().uuid().optional(),
  durationMin: z.coerce.number().int().min(5).max(60).default(15),
  voiceEnabled: z.boolean().default(true),
  proctoringEnabled: z.boolean().default(false),
  startDifficulty: z.nativeEnum(Difficulty).default(Difficulty.MEDIUM),
});

export const consentSchema = z.object({
  accepted: z.boolean(),
  cameraGranted: z.boolean().default(false),
  microphoneGranted: z.boolean().default(false),
});

export const submitAnswerSchema = z.object({
  transcript: z.string().max(20_000),
  sttProvider: z.string().trim().max(60).optional(),
  sttConfidence: z.coerce.number().min(0).max(1).optional(),
  durationSec: z.coerce.number().int().min(0).max(3600).optional(),
  audioAssetId: z.string().uuid().optional(),
});

export const listVivaSchema = z.object({
  studentId: z.string().uuid().optional(),
  status: z.nativeEnum(VivaStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const ingestEventsSchema = z.object({
  context: z.nativeEnum(ProctoringContext),
  sessionId: z.string().uuid(),
  events: z
    .array(
      z.object({
        type: z.nativeEnum(ProctoringEventType),
        occurredAt: z.coerce.date(),
        durationMs: z.coerce.number().int().min(0).max(3_600_000).optional(),
        detail: z.record(z.unknown()).optional(),
        clientTimestamp: z.coerce.date().optional(),
      }),
    )
    .min(1)
    .max(100),
});

export const reviewEventSchema = z.object({
  status: z.nativeEnum(ProctoringReviewStatus),
  note: z.string().trim().max(1000).optional(),
});
