import { EnrollmentStatus } from '@prisma/client';
import { z } from 'zod';
import { paginationSchema } from '../../lib/pagination';

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour such as #5CB82B');

export const listQuerySchema = paginationSchema.extend({
  isActive: z.coerce.boolean().optional(),
  classGroupId: z.string().uuid().optional(),
});

export const createClassSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(20).toUpperCase(),
  academicYear: z.string().trim().regex(/^\d{4}-\d{2}$/, 'Use the form 2025-26'),
  gradeLevel: z.coerce.number().int().min(1).max(15).optional(),
  description: z.string().trim().max(400).optional(),
});

export const updateClassSchema = createClassSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const createBatchSchema = z.object({
  classGroupId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(20).toUpperCase(),
  capacity: z.coerce.number().int().min(1).max(500).default(40),
  room: z.string().trim().max(40).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});

export const updateBatchSchema = createBatchSchema.omit({ classGroupId: true }).partial().extend({
  isActive: z.boolean().optional(),
});

export const createSubjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(20).toUpperCase(),
  colorHex: hexColor.default('#5CB82B'),
  iconKey: z.string().trim().max(40).default('book'),
  description: z.string().trim().max(400).optional(),
});

export const updateSubjectSchema = createSubjectSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const enrollSchema = z.object({
  studentIds: z.array(z.string().uuid()).min(1).max(200),
  rollNumberPrefix: z.string().trim().max(10).optional(),
});

export const updateEnrollmentSchema = z.object({
  status: z.nativeEnum(EnrollmentStatus),
  rollNumber: z.string().trim().max(20).nullable().optional(),
});

export const assignTeacherSchema = z.object({
  teacherId: z.string().uuid(),
  subjectId: z.string().uuid(),
  isPrimary: z.boolean().default(true),
});
