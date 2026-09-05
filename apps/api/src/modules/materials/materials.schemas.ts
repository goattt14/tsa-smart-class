import { MaterialType, Visibility } from '@prisma/client';
import { z } from 'zod';
import { paginationSchema } from '../../lib/pagination';

export const listMaterialsSchema = paginationSchema.extend({
  batchId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  topicId: z.string().uuid().optional(),
  type: z.nativeEnum(MaterialType).optional(),
});

/**
 * Multipart bodies arrive as strings, so booleans and enums are coerced here
 * rather than trusted. z.coerce on a checkbox value of "false" would be truthy,
 * hence the explicit string comparison.
 */
const multipartBoolean = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => (typeof value === 'string' ? value === 'true' : (value ?? false)));

export const createMaterialSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).optional(),
  subjectId: z.string().uuid(),
  batchId: z.string().uuid().optional(),
  topicId: z.string().uuid().optional(),
  type: z.nativeEnum(MaterialType),
  externalUrl: z.string().url().max(600).optional(),
  visibility: z.nativeEnum(Visibility).default(Visibility.BATCH),
  isCurriculumApproved: multipartBoolean,
  rawText: z.string().max(200_000).optional(),
});

export const updateMaterialSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  topicId: z.string().uuid().nullable().optional(),
  visibility: z.nativeEnum(Visibility).optional(),
  isCurriculumApproved: z.boolean().optional(),
});
