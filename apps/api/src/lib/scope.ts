import { Role, type Prisma } from '@prisma/client';
import type { AuthContext } from '../types/express';
import { forbidden } from './http-error';
import { prisma } from './prisma';

/**
 * Returns a Prisma filter describing exactly which students the caller may see.
 *
 * Centralising this is the whole point: every endpoint that lists or reads
 * student data composes this filter instead of inventing its own rule, so a
 * missed check in one controller cannot open a hole.
 */
export function studentVisibilityFilter(auth: AuthContext): Prisma.StudentProfileWhereInput {
  const inInstitute: Prisma.StudentProfileWhereInput = {
    deletedAt: null,
    user: { instituteId: auth.instituteId, deletedAt: null },
  };

  switch (auth.role) {
    case Role.ADMIN:
      return inInstitute;

    case Role.STUDENT:
      return { ...inInstitute, id: auth.profileId ?? '__none__' };

    case Role.PARENT:
      return {
        ...inInstitute,
        parentLinks: { some: { parentId: auth.profileId ?? '__none__' } },
      };

    case Role.TEACHER:
      return {
        ...inInstitute,
        enrollments: {
          some: {
            status: 'ACTIVE',
            batch: {
              deletedAt: null,
              teacherAssignment: { some: { teacherId: auth.profileId ?? '__none__' } },
            },
          },
        },
      };

    case Role.MANAGEMENT:
      // Aggregate-only accounts get no row-level student access at all. An admin
      // must issue an explicit override to change that.
      return auth.aggregateOnly ? { ...inInstitute, id: '__none__' } : inInstitute;

    default:
      return { ...inInstitute, id: '__none__' };
  }
}

/** Throws unless the caller is allowed to read this specific student. */
export async function assertCanReadStudent(
  auth: AuthContext,
  studentId: string,
): Promise<void> {
  if (auth.role === Role.STUDENT && auth.profileId === studentId) return;

  const visible = await prisma.studentProfile.findFirst({
    where: { AND: [{ id: studentId }, studentVisibilityFilter(auth)] },
    select: { id: true },
  });

  if (!visible) {
    throw forbidden('You do not have access to this student.');
  }
}

/** Batches the caller may act on. Teachers are limited to their assignments. */
export function batchVisibilityFilter(auth: AuthContext): Prisma.BatchWhereInput {
  const base: Prisma.BatchWhereInput = {
    deletedAt: null,
    classGroup: { instituteId: auth.instituteId, deletedAt: null },
  };

  switch (auth.role) {
    case Role.ADMIN:
    case Role.MANAGEMENT:
      return base;

    case Role.TEACHER:
      return {
        ...base,
        teacherAssignment: { some: { teacherId: auth.profileId ?? '__none__' } },
      };

    case Role.STUDENT:
      return {
        ...base,
        enrollments: { some: { studentId: auth.profileId ?? '__none__', status: 'ACTIVE' } },
      };

    case Role.PARENT:
      return {
        ...base,
        enrollments: {
          some: {
            status: 'ACTIVE',
            student: { parentLinks: { some: { parentId: auth.profileId ?? '__none__' } } },
          },
        },
      };

    default:
      return { ...base, id: '__none__' };
  }
}
