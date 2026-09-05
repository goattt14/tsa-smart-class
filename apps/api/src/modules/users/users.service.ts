import crypto from 'node:crypto';
import { Prisma, Role, UserStatus, type ParentRelation } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { conflict, notFound, unprocessable } from '../../lib/http-error';
import { hashPassword } from '../../lib/password';
import { buildPageMeta } from '../../lib/api-response';
import { safeOrderBy, toSkipTake } from '../../lib/pagination';
import { studentVisibilityFilter } from '../../lib/scope';
import { invalidateUserPermissions } from '../auth/permission.service';
import type { AuthContext } from '../../types/express';
import type { CreateUserInput, UpdateUserInput } from './users.schemas';

const USER_LIST_SORTS = ['createdAt', 'firstName', 'lastName', 'email', 'lastLoginAt'] as const;

export const userSummarySelect = {
  id: true,
  email: true,
  phone: true,
  role: true,
  status: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  lastLoginAt: true,
  mustChangePassword: true,
  isDemoAccount: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

/** A temporary password for invited accounts, forced to change at first sign-in. */
export function generateTemporaryPassword(): string {
  // Ambiguous glyphs are omitted so a password read off a printed slip is typed
  // correctly the first time.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }
  return `${out}#7`;
}

export interface ListUsersArgs {
  page: number;
  pageSize: number;
  search?: string | undefined;
  sort?: string | undefined;
  order: 'asc' | 'desc';
  role?: Role | undefined;
  status?: UserStatus | undefined;
  batchId?: string | undefined;
  includeDeleted: boolean;
}

export async function listUsers(auth: AuthContext, args: ListUsersArgs) {
  const where: Prisma.UserWhereInput = {
    instituteId: auth.instituteId,
    ...(args.includeDeleted ? {} : { deletedAt: null }),
    ...(args.role ? { role: args.role } : {}),
    ...(args.status ? { status: args.status } : {}),
  };

  /**
   * Conditions are collected into AND rather than assigned onto `where`
   * directly. Two independent filters both wanting the OR slot would otherwise
   * overwrite each other, and the one that lost would vanish silently.
   */
  const conditions: Prisma.UserWhereInput[] = [];

  if (args.search) {
    conditions.push({
      OR: [
        { firstName: { contains: args.search, mode: 'insensitive' } },
        { lastName: { contains: args.search, mode: 'insensitive' } },
        { email: { contains: args.search, mode: 'insensitive' } },
      ],
    });
  }

  if (args.batchId) {
    conditions.push({
      studentProfile: { enrollments: { some: { batchId: args.batchId, status: 'ACTIVE' } } },
    });
  }

  /**
   * A teacher may list the students they teach and their colleagues, but not
   * browse the whole roll. The visibility filter from scope.ts is folded into
   * the same query rather than living in a separate endpoint.
   */
  if (auth.role === Role.TEACHER) {
    conditions.push({
      OR: [
        { studentProfile: studentVisibilityFilter(auth) },
        { role: { in: [Role.TEACHER, Role.ADMIN] } },
      ],
    });
  }

  if (conditions.length > 0) where.AND = conditions;

  const orderBy = safeOrderBy(args.sort, USER_LIST_SORTS, 'createdAt', args.order);
  const { skip, take } = toSkipTake(args);

  const [items, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy, skip, take, select: userSummarySelect }),
    prisma.user.count({ where }),
  ]);

  return { items, meta: buildPageMeta(args.page, args.pageSize, total) };
}

export async function getUserDetail(auth: AuthContext, userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, instituteId: auth.instituteId, deletedAt: null },
    select: {
      ...userSummarySelect,
      locale: true,
      timezone: true,
      emailVerifiedAt: true,
      lockedUntil: true,
      passwordChangedAt: true,
      studentProfile: {
        include: {
          enrollments: {
            where: { status: 'ACTIVE' },
            select: {
              id: true,
              rollNumber: true,
              batch: {
                select: {
                  id: true,
                  name: true,
                  code: true,
                  classGroup: { select: { id: true, name: true } },
                },
              },
            },
          },
          parentLinks: {
            select: {
              relation: true,
              isPrimary: true,
              parent: {
                select: {
                  id: true,
                  user: { select: { firstName: true, lastName: true, email: true, phone: true } },
                },
              },
            },
          },
        },
      },
      teacherProfile: {
        include: {
          assignments: {
            select: {
              id: true,
              isPrimary: true,
              batch: { select: { id: true, name: true } },
              subject: { select: { id: true, name: true, colorHex: true } },
            },
          },
        },
      },
      parentProfile: {
        include: {
          children: {
            select: {
              relation: true,
              isPrimary: true,
              canViewFees: true,
              canViewReport: true,
              student: {
                select: {
                  id: true,
                  admissionNumber: true,
                  user: { select: { firstName: true, lastName: true, avatarUrl: true } },
                },
              },
            },
          },
        },
      },
      staffProfile: true,
      permissionOverrides: {
        select: {
          id: true,
          effect: true,
          reason: true,
          expiresAt: true,
          permission: { select: { key: true, description: true, isSensitive: true } },
        },
      },
    },
  });

  if (!user) throw notFound('User');
  return user;
}

interface CreateResult {
  userId: string;
  temporaryPassword: string | null;
}

/**
 * Creates the user, their role profile and any links in a single transaction.
 * A half-created student with no profile row would break every downstream join,
 * so the whole thing commits or none of it does.
 */
export async function createUser(
  auth: AuthContext,
  input: CreateUserInput,
): Promise<CreateResult> {
  const existing = await prisma.user.findFirst({
    where: { email: input.email },
    select: { id: true, deletedAt: true },
  });

  if (existing) {
    throw conflict(
      existing.deletedAt
        ? 'A deleted account already uses this email. Restore it instead of creating a duplicate.'
        : 'That email is already registered.',
    );
  }

  const temporaryPassword = input.password ? null : generateTemporaryPassword();
  const passwordHash = await hashPassword(input.password ?? temporaryPassword ?? '');

  const userId = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        instituteId: auth.instituteId,
        email: input.email,
        phone: input.phone || null,
        passwordHash,
        role: input.role,
        firstName: input.firstName,
        lastName: input.lastName,
        status: input.sendInvite ? UserStatus.INVITED : UserStatus.ACTIVE,
        mustChangePassword: !input.password,
      },
      select: { id: true },
    });

    if (input.role === Role.STUDENT) {
      const profile = await tx.studentProfile.create({
        data: {
          userId: user.id,
          admissionNumber: input.student.admissionNumber,
          rollNumber: input.student.rollNumber || null,
          dateOfBirth: input.student.dateOfBirth ?? null,
          gender: input.student.gender,
          bloodGroup: input.student.bloodGroup || null,
          addressLine1: input.student.addressLine1 || null,
          city: input.student.city || null,
          state: input.student.state || null,
          postalCode: input.student.postalCode || null,
          schoolName: input.student.schoolName || null,
          boardName: input.student.boardName || null,
          admissionDate: input.student.admissionDate ?? null,
          emergencyContact: input.student.emergencyContact || null,
          notes: input.student.notes || null,
        },
        select: { id: true },
      });

      for (const batchId of input.student.batchIds) {
        const batch = await tx.batch.findFirst({
          where: { id: batchId, classGroup: { instituteId: auth.instituteId } },
          select: { id: true, capacity: true, _count: { select: { enrollments: true } } },
        });

        if (!batch) throw unprocessable(`Batch ${batchId} does not belong to this institute.`);
        if (batch._count.enrollments >= batch.capacity) {
          throw unprocessable('That batch is already at capacity.');
        }

        await tx.enrollment.create({
          data: {
            studentId: profile.id,
            batchId,
            rollNumber: input.student.rollNumber || null,
          },
        });
      }
    }

    if (input.role === Role.TEACHER) {
      await tx.teacherProfile.create({
        data: {
          userId: user.id,
          employeeCode: input.teacher.employeeCode,
          qualification: input.teacher.qualification || null,
          specialization: input.teacher.specialization || null,
          experienceYear: input.teacher.experienceYear,
          joiningDate: input.teacher.joiningDate ?? null,
          bio: input.teacher.bio || null,
          isFullTime: input.teacher.isFullTime,
        },
      });
    }

    if (input.role === Role.PARENT) {
      const profile = await tx.parentProfile.create({
        data: {
          userId: user.id,
          occupation: input.parent.occupation || null,
          addressLine1: input.parent.addressLine1 || null,
          city: input.parent.city || null,
        },
        select: { id: true },
      });

      for (const child of input.parent.children) {
        const student = await tx.studentProfile.findFirst({
          where: { id: child.studentId, user: { instituteId: auth.instituteId } },
          select: { id: true },
        });

        if (!student) {
          throw unprocessable(`Student ${child.studentId} does not belong to this institute.`);
        }

        await tx.parentStudentLink.create({
          data: {
            parentId: profile.id,
            studentId: child.studentId,
            relation: child.relation,
            isPrimary: child.isPrimary,
            canViewFees: child.canViewFees,
            canViewReport: child.canViewReport,
          },
        });
      }
    }

    if (input.role === Role.ADMIN || input.role === Role.MANAGEMENT) {
      await tx.staffProfile.create({
        data: {
          userId: user.id,
          staffType: input.staff.staffType,
          employeeCode: input.staff.employeeCode,
          designation: input.staff.designation || null,
          department: input.staff.department || null,
          accessScope: { aggregateOnly: input.staff.aggregateOnly },
          joiningDate: input.staff.joiningDate ?? null,
        },
      });
    }

    return user.id;
  });

  return { userId, temporaryPassword };
}

export async function updateUser(auth: AuthContext, userId: string, input: UpdateUserInput) {
  const before = await prisma.user.findFirst({
    where: { id: userId, instituteId: auth.instituteId, deletedAt: null },
    select: userSummarySelect,
  });

  if (!before) throw notFound('User');

  const after = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
    select: userSummarySelect,
  });

  return { before, after };
}

export async function setUserStatus(
  auth: AuthContext,
  userId: string,
  status: UserStatus,
) {
  if (userId === auth.userId) {
    throw unprocessable('You cannot change the status of your own account.');
  }

  const user = await prisma.user.findFirst({
    where: { id: userId, instituteId: auth.instituteId, deletedAt: null },
    select: { id: true, status: true, role: true },
  });

  if (!user) throw notFound('User');

  // Guard against locking the institute out of its own admin panel.
  if (user.role === Role.ADMIN && status !== UserStatus.ACTIVE) {
    const activeAdmins = await prisma.user.count({
      where: {
        instituteId: auth.instituteId,
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
    });
    if (activeAdmins <= 1) {
      throw unprocessable('This is the last active administrator. Promote someone else first.');
    }
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { status },
    select: userSummarySelect,
  });

  if (status !== UserStatus.ACTIVE) {
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: `STATUS_${status}` },
    });
  }

  invalidateUserPermissions(userId);
  return { before: user, after: updated };
}

/** Soft delete. History, marks and audit trails must survive the account. */
export async function softDeleteUser(auth: AuthContext, userId: string) {
  if (userId === auth.userId) throw unprocessable('You cannot delete your own account.');

  const user = await prisma.user.findFirst({
    where: { id: userId, instituteId: auth.instituteId, deletedAt: null },
    select: { id: true, email: true, role: true },
  });

  if (!user) throw notFound('User');

  const now = new Date();

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        deletedAt: now,
        status: UserStatus.DISABLED,
        // Free the unique email so a future account can reuse the address.
        email: `deleted+${userId}@deleted.invalid`,
        phone: null,
      },
    }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'USER_DELETED' },
    }),
    prisma.studentProfile.updateMany({ where: { userId }, data: { deletedAt: now } }),
    prisma.teacherProfile.updateMany({ where: { userId }, data: { deletedAt: now } }),
    prisma.parentProfile.updateMany({ where: { userId }, data: { deletedAt: now } }),
    prisma.staffProfile.updateMany({ where: { userId }, data: { deletedAt: now } }),
  ]);

  invalidateUserPermissions(userId);
  return user;
}

export async function resetUserPassword(auth: AuthContext, userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, instituteId: auth.instituteId, deletedAt: null },
    select: { id: true, email: true },
  });

  if (!user) throw notFound('User');

  const temporaryPassword = generateTemporaryPassword();

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'ADMIN_PASSWORD_RESET' },
    }),
  ]);

  return { email: user.email, temporaryPassword };
}

export async function overridePermission(
  auth: AuthContext,
  userId: string,
  permissionKey: string,
  effect: 'GRANT' | 'REVOKE',
  reason: string,
  expiresAt?: Date,
) {
  const [user, permission] = await Promise.all([
    prisma.user.findFirst({
      where: { id: userId, instituteId: auth.instituteId, deletedAt: null },
      select: { id: true, role: true },
    }),
    prisma.permission.findUnique({ where: { key: permissionKey }, select: { id: true } }),
  ]);

  if (!user) throw notFound('User');
  if (!permission) throw unprocessable(`Unknown permission "${permissionKey}".`);

  const record = await prisma.userPermission.upsert({
    where: { userId_permissionId: { userId, permissionId: permission.id } },
    update: { effect, reason, grantedById: auth.userId, expiresAt: expiresAt ?? null },
    create: {
      userId,
      permissionId: permission.id,
      effect,
      reason,
      grantedById: auth.userId,
      expiresAt: expiresAt ?? null,
    },
    select: {
      id: true,
      effect: true,
      reason: true,
      expiresAt: true,
      permission: { select: { key: true, isSensitive: true } },
    },
  });

  invalidateUserPermissions(userId);
  return record;
}

export async function clearPermissionOverride(
  auth: AuthContext,
  userId: string,
  permissionKey: string,
) {
  const permission = await prisma.permission.findUnique({
    where: { key: permissionKey },
    select: { id: true },
  });

  if (!permission) throw unprocessable(`Unknown permission "${permissionKey}".`);

  const deleted = await prisma.userPermission.deleteMany({
    where: { userId, permissionId: permission.id, user: { instituteId: auth.instituteId } },
  });

  if (deleted.count === 0) throw notFound('Permission override');

  invalidateUserPermissions(userId);
}

export async function linkParentToStudent(
  auth: AuthContext,
  parentUserId: string,
  input: {
    studentId: string;
    relation: ParentRelation;
    isPrimary: boolean;
    canViewFees: boolean;
    canViewReport: boolean;
  },
) {
  const parent = await prisma.parentProfile.findFirst({
    where: { userId: parentUserId, user: { instituteId: auth.instituteId, deletedAt: null } },
    select: { id: true },
  });

  if (!parent) throw notFound('Parent');

  const student = await prisma.studentProfile.findFirst({
    where: { id: input.studentId, user: { instituteId: auth.instituteId, deletedAt: null } },
    select: { id: true },
  });

  if (!student) throw notFound('Student');

  return prisma.parentStudentLink.upsert({
    where: { parentId_studentId: { parentId: parent.id, studentId: student.id } },
    update: {
      relation: input.relation,
      isPrimary: input.isPrimary,
      canViewFees: input.canViewFees,
      canViewReport: input.canViewReport,
    },
    create: {
      parentId: parent.id,
      studentId: student.id,
      relation: input.relation,
      isPrimary: input.isPrimary,
      canViewFees: input.canViewFees,
      canViewReport: input.canViewReport,
    },
    select: { id: true, relation: true, isPrimary: true },
  });
}
