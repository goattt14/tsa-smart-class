import { SelfStudyStatus } from '@prisma/client';
import { z } from 'zod';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form YYYY-MM-DD');
const minuteOfDay = z.coerce.number().int().min(0).max(1440);

export const listSessionsSchema = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
  studentId: z.string().uuid().optional(),
  status: z.nativeEnum(SelfStudyStatus).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});

export const generateSchema = z.object({
  classSessionId: z.string().uuid(),
  /** Preview the plan without writing anything. */
  dryRun: z.boolean().default(false),
});

export const lifecycleSchema = z.object({
  activeMinutes: z.coerce.number().int().min(0).max(600).optional(),
  skipReason: z.string().trim().max(300).optional(),
});

export const updatePolicySchema = z.object({
  defaultDurationMin: z.coerce.number().int().min(30).max(480).optional(),
  taskCount: z.coerce.number().int().min(1).max(8).optional(),
  focusMinPerTask: z.coerce.number().int().min(10).max(180).optional(),
  evaluationMinPerTask: z.coerce.number().int().min(0).max(120).optional(),
  newSessionCutoffMin: minuteOfDay.optional(),
  blackoutEndMin: minuteOfDay.optional(),
  minGapAfterClassMin: z.coerce.number().int().min(0).max(300).optional(),
  reminderLeadMin: z.coerce.number().int().min(0).max(120).optional(),
  allowWeekend: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const createRuleSchema = z.object({
  label: z.string().trim().min(3).max(120),
  batchId: z.string().uuid().nullable().optional(),
  lectureStartMinFrom: minuteOfDay,
  lectureStartMinTo: minuteOfDay,
  selfStudyStartMin: minuteOfDay,
  durationMin: z.coerce.number().int().min(30).max(480).default(120),
  dayOffset: z.enum(['SAME_DAY', 'NEXT_DAY']).default('SAME_DAY'),
  priority: z.coerce.number().int().min(1).max(1000).default(100),
});

export const updateRuleSchema = createRuleSchema.partial().extend({
  isActive: z.boolean().optional(),
});
