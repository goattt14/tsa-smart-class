import { Gender, ParentRelation, Role, StaffType, UserStatus } from '@prisma/client';
import { z } from 'zod';
import { paginationSchema } from '../../lib/pagination';

const nameField = z.string().trim().min(1).max(80);
const optionalText = (max: number) => z.string().trim().max(max).optional();

export const listUsersSchema = paginationSchema.extend({
  role: z.nativeEnum(Role).optional(),
  status: z.nativeEnum(UserStatus).optional(),
  batchId: z.string().uuid().optional(),
  includeDeleted: z.coerce.boolean().default(false),
});

const studentDetails = z.object({
  admissionNumber: z.string().trim().min(1).max(40),
  rollNumber: optionalText(20),
  dateOfBirth: z.coerce.date().optional(),
  gender: z.nativeEnum(Gender).default(Gender.UNDISCLOSED),
  bloodGroup: optionalText(8),
  addressLine1: optionalText(200),
  city: optionalText(80),
  state: optionalText(80),
  postalCode: optionalText(12),
  schoolName: optionalText(140),
  boardName: optionalText(40),
  admissionDate: z.coerce.date().optional(),
  emergencyContact: optionalText(40),
  notes: optionalText(500),
  batchIds: z.array(z.string().uuid()).max(10).default([]),
});

const teacherDetails = z.object({
  employeeCode: z.string().trim().min(1).max(40),
  qualification: optionalText(140),
  specialization: optionalText(140),
  experienceYear: z.coerce.number().int().min(0).max(60).default(0),
  joiningDate: z.coerce.date().optional(),
  bio: optionalText(600),
  isFullTime: z.boolean().default(true),
});

const parentDetails = z.object({
  occupation: optionalText(120),
  addressLine1: optionalText(200),
  city: optionalText(80),
  children: z
    .array(
      z.object({
        studentId: z.string().uuid(),
        relation: z.nativeEnum(ParentRelation).default(ParentRelation.GUARDIAN),
        isPrimary: z.boolean().default(false),
        canViewFees: z.boolean().default(true),
        canViewReport: z.boolean().default(true),
      }),
    )
    .max(10)
    .default([]),
});

const staffDetails = z.object({
  staffType: z.nativeEnum(StaffType),
  employeeCode: z.string().trim().min(1).max(40),
  designation: optionalText(120),
  department: optionalText(120),
  /**
   * Aggregate-only is the default for management. Clearing it is an explicit,
   * audited act, never an accident of omission.
   */
  aggregateOnly: z.boolean().default(true),
  joiningDate: z.coerce.date().optional(),
});

/**
 * A discriminated union means the compiler, not a runtime `if`, guarantees that
 * a STUDENT payload carries an admission number and a TEACHER payload does not.
 */
export const createUserSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal(Role.STUDENT),
    email: z.string().trim().toLowerCase().email().max(190),
    phone: optionalText(20),
    firstName: nameField,
    lastName: nameField,
    password: z.string().min(10).max(128).optional(),
    sendInvite: z.boolean().default(true),
    student: studentDetails,
  }),
  z.object({
    role: z.literal(Role.TEACHER),
    email: z.string().trim().toLowerCase().email().max(190),
    phone: optionalText(20),
    firstName: nameField,
    lastName: nameField,
    password: z.string().min(10).max(128).optional(),
    sendInvite: z.boolean().default(true),
    teacher: teacherDetails,
  }),
  z.object({
    role: z.literal(Role.PARENT),
    email: z.string().trim().toLowerCase().email().max(190),
    phone: optionalText(20),
    firstName: nameField,
    lastName: nameField,
    password: z.string().min(10).max(128).optional(),
    sendInvite: z.boolean().default(true),
    parent: parentDetails,
  }),
  z.object({
    role: z.literal(Role.ADMIN),
    email: z.string().trim().toLowerCase().email().max(190),
    phone: optionalText(20),
    firstName: nameField,
    lastName: nameField,
    password: z.string().min(10).max(128).optional(),
    sendInvite: z.boolean().default(true),
    staff: staffDetails,
  }),
  z.object({
    role: z.literal(Role.MANAGEMENT),
    email: z.string().trim().toLowerCase().email().max(190),
    phone: optionalText(20),
    firstName: nameField,
    lastName: nameField,
    password: z.string().min(10).max(128).optional(),
    sendInvite: z.boolean().default(true),
    staff: staffDetails,
  }),
]);

export const updateUserSchema = z.object({
  firstName: nameField.optional(),
  lastName: nameField.optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  avatarUrl: z.string().url().max(500).nullable().optional(),
  locale: optionalText(10),
  timezone: optionalText(60),
  status: z.nativeEnum(UserStatus).optional(),
});

export const setStatusSchema = z.object({
  status: z.nativeEnum(UserStatus),
  reason: z.string().trim().max(300).optional(),
});

export const overridePermissionSchema = z.object({
  permissionKey: z.string().trim().min(3).max(80),
  effect: z.enum(['GRANT', 'REVOKE']),
  reason: z.string().trim().min(3).max(300),
  expiresAt: z.coerce.date().optional(),
});

export const linkChildSchema = z.object({
  studentId: z.string().uuid(),
  relation: z.nativeEnum(ParentRelation).default(ParentRelation.GUARDIAN),
  isPrimary: z.boolean().default(false),
  canViewFees: z.boolean().default(true),
  canViewReport: z.boolean().default(true),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
