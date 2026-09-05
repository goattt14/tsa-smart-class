import { SessionStatus, Weekday } from '@prisma/client';
import { z } from 'zod';

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form YYYY-MM-DD');

const minuteOfDay = z.coerce.number().int().min(0).max(1440);

export const listSlotsSchema = z.object({
  batchId: z.string().uuid().optional(),
  teacherId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  weekday: z.nativeEnum(Weekday).optional(),
  includeInactive: z.coerce.boolean().default(false),
});

export const createSlotSchema = z.object({
  batchId: z.string().uuid(),
  subjectId: z.string().uuid(),
  teacherId: z.string().uuid(),
  weekday: z.nativeEnum(Weekday),
  startTimeMin: minuteOfDay,
  endTimeMin: minuteOfDay,
  room: z.string().trim().max(40).optional(),
  effectiveFrom: dateString,
  effectiveTo: dateString.nullable().optional(),
});

export const updateSlotSchema = createSlotSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const generateSessionsSchema = z.object({
  from: dateString,
  to: dateString,
  batchId: z.string().uuid().optional(),
  /** Replaces sessions that exist but have drifted from the timetable. */
  reconcile: z.boolean().default(false),
});

export const listSessionsSchema = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
  batchId: z.string().uuid().optional(),
  teacherId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  status: z.nativeEnum(SessionStatus).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const updateSessionSchema = z.object({
  status: z.nativeEnum(SessionStatus).optional(),
  topicId: z.string().uuid().nullable().optional(),
  room: z.string().trim().max(40).nullable().optional(),
  cancelReason: z.string().trim().max(300).optional(),
  actualStartAt: z.coerce.date().optional(),
  actualEndAt: z.coerce.date().optional(),
});
