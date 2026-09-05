import { ComplianceStatus } from '@prisma/client';
import { z } from 'zod';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form YYYY-MM-DD');

export const submitLogSchema = z.object({
  topic: z.string().trim().min(2).max(160),
  description: z.string().trim().min(10, 'Describe what was actually taught.').max(4000),
  notes: z.string().trim().max(2000).optional(),
  keyPoints: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  homeworkGiven: z.string().trim().max(1000).optional(),
});

export const listLogsSchema = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
  teacherId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
  compliance: z.nativeEnum(ComplianceStatus).optional(),
  limit: z.coerce.number().int().min(1).max(300).default(100),
});

export const complianceReportSchema = z.object({
  from: dateString,
  to: dateString,
  teacherId: z.string().uuid().optional(),
});
