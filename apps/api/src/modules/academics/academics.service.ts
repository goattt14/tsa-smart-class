import { EnrollmentStatus, Prisma, Role } from '@prisma/client';
import { buildPageMeta } from '../../lib/api-response';
import { conflict, notFound, unprocessable } from '../../lib/http-error';
import { safeOrderBy, toSkipTake } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import { batchVisibilityFilter } from '../../lib/scope';
import type { AuthContext } from '../../types/express';

const CLASS_SORTS = ['name', 'code', 'createdAt', 'gradeLevel'] as const;
const BATCH_SORTS = ['name', 'code', 'createdAt'] as const;
const SUBJECT_SORTS = ['name', 'code', 'createdAt'] as const;

interface ListArgs {
  page: number;
  pageSize: number;
  search?: string | undefined;
  sort?: string | undefined;
  order: 'asc' | 'desc';
  isActive?: boolean | undefined;
  classGroupId?: string | undefined;
}

// ----------------------------------------------------------------- classes --

export async function listClasses(auth: AuthContext, args: ListArgs) {
  const where: Prisma.ClassGroupWhereInput = {
    instituteId: auth.instituteId,
    deletedAt: null,
    ...(args.isActive !== undefined ? { isActive: args.isActive } : {}),
    ...(args.search
      ? {
          OR: [
            { name: { contains: args.search, mode: 'insensitive' } },
            { code: { contains: args.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const { skip, take } = toSkipTake(args);

  const [items, total] = await Promise.all([
    prisma.classGroup.findMany({
      where,
      orderBy: safeOrderBy(args.sort, CLASS_SORTS, 'name', args.order),
      skip,
      take,
      select: {
        id: true,
        name: true,
        code: true,
        academicYear: true,
        gradeLevel: true,
        description: true,
        isActive: true,
        createdAt: true,
        _count: { select: { batches: true } },
      },
    }),
    prisma.classGroup.count({ where }),
  ]);

  return { items, meta: buildPageMeta(args.page, args.pageSize, total) };
}

export async function createClass(auth: AuthContext, input: {
  name: string;
  code: string;
  academicYear: string;
  gradeLevel?: number | undefined;
  description?: string | undefined;
}) {
  const duplicate = await prisma.classGroup.findFirst({
    where: {
      instituteId: auth.instituteId,
      code: input.code,
      academicYear: input.academicYear,
    },
    select: { id: true },
  });

  if (duplicate) {
    throw conflict(`A class with code ${input.code} already exists for ${input.academicYear}.`);
  }

  return prisma.classGroup.create({
    data: {
      instituteId: auth.instituteId,
      name: input.name,
      code: input.code,
      academicYear: input.academicYear,
      gradeLevel: input.gradeLevel ?? null,
      description: input.description || null,
    },
  });
}

export async function updateClass(
  auth: AuthContext,
  classId: string,
  input: Partial<{
    name: string;
    code: string;
    academicYear: string;
    gradeLevel: number;
    description: string;
    isActive: boolean;
  }>,
) {
  const existing = await prisma.classGroup.findFirst({
    where: { id: classId, instituteId: auth.instituteId, deletedAt: null },
  });

  if (!existing) throw notFound('Class');

  const after = await prisma.classGroup.update({
    where: { id: classId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.academicYear !== undefined ? { academicYear: input.academicYear } : {}),
      ...(input.gradeLevel !== undefined ? { gradeLevel: input.gradeLevel } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });

  return { before: existing, after };
}

export async function deleteClass(auth: AuthContext, classId: string) {
  const existing = await prisma.classGroup.findFirst({
    where: { id: classId, instituteId: auth.instituteId, deletedAt: null },
    select: { id: true, name: true, _count: { select: { batches: true } } },
  });

  if (!existing) throw notFound('Class');

  if (existing._count.batches > 0) {
    throw unprocessable(
      'This class still has batches. Move or archive them before deleting the class.',
    );
  }

  await prisma.classGroup.update({
    where: { id: classId },
    data: { deletedAt: new Date(), isActive: false },
  });

  return existing;
}

// ----------------------------------------------------------------- batches --

export async function listBatches(auth: AuthContext, args: ListArgs) {
  const where: Prisma.BatchWhereInput = {
    ...batchVisibilityFilter(auth),
    ...(args.classGroupId ? { classGroupId: args.classGroupId } : {}),
    ...(args.isActive !== undefined ? { isActive: args.isActive } : {}),
    ...(args.search
      ? {
          OR: [
            { name: { contains: args.search, mode: 'insensitive' } },
            { code: { contains: args.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const { skip, take } = toSkipTake(args);

  const [items, total] = await Promise.all([
    prisma.batch.findMany({
      where,
      orderBy: safeOrderBy(args.sort, BATCH_SORTS, 'name', args.order),
      skip,
      take,
      select: {
        id: true,
        name: true,
        code: true,
        capacity: true,
        room: true,
        isActive: true,
        startDate: true,
        endDate: true,
        classGroup: { select: { id: true, name: true, code: true, academicYear: true } },
        _count: { select: { enrollments: true, teacherAssignment: true } },
      },
    }),
    prisma.batch.count({ where }),
  ]);

  return { items, meta: buildPageMeta(args.page, args.pageSize, total) };
}

export async function getBatch(auth: AuthContext, batchId: string) {
  const batch = await prisma.batch.findFirst({
    where: { AND: [{ id: batchId }, batchVisibilityFilter(auth)] },
    select: {
      id: true,
      name: true,
      code: true,
      capacity: true,
      room: true,
      isActive: true,
      startDate: true,
      endDate: true,
      classGroup: { select: { id: true, name: true, code: true, academicYear: true } },
      teacherAssignment: {
        select: {
          id: true,
          isPrimary: true,
          subject: { select: { id: true, name: true, code: true, colorHex: true } },
          teacher: {
            select: {
              id: true,
              employeeCode: true,
              user: { select: { firstName: true, lastName: true, avatarUrl: true } },
            },
          },
        },
      },
      enrollments: {
        where: { status: 'ACTIVE' },
        orderBy: { rollNumber: 'asc' },
        select: {
          id: true,
          rollNumber: true,
          status: true,
          joinedAt: true,
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
  });

  if (!batch) throw notFound('Batch');
  return batch;
}

export async function createBatch(auth: AuthContext, input: {
  classGroupId: string;
  name: string;
  code: string;
  capacity: number;
  room?: string | undefined;
  startDate?: Date | undefined;
  endDate?: Date | undefined;
}) {
  const classGroup = await prisma.classGroup.findFirst({
    where: { id: input.classGroupId, instituteId: auth.instituteId, deletedAt: null },
    select: { id: true },
  });

  if (!classGroup) throw notFound('Class');

  if (input.startDate && input.endDate && input.endDate <= input.startDate) {
    throw unprocessable('The end date must fall after the start date.');
  }

  const duplicate = await prisma.batch.findFirst({
    where: { classGroupId: input.classGroupId, code: input.code },
    select: { id: true },
  });

  if (duplicate) throw conflict(`Batch code ${input.code} is already used in this class.`);

  return prisma.batch.create({
    data: {
      classGroupId: input.classGroupId,
      name: input.name,
      code: input.code,
      capacity: input.capacity,
      room: input.room || null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
    },
  });
}

export async function updateBatch(
  auth: AuthContext,
  batchId: string,
  input: Partial<{
    name: string;
    code: string;
    capacity: number;
    room: string;
    startDate: Date;
    endDate: Date;
    isActive: boolean;
  }>,
) {
  const existing = await prisma.batch.findFirst({
    where: { id: batchId, classGroup: { instituteId: auth.instituteId }, deletedAt: null },
    select: { id: true, name: true, capacity: true, _count: { select: { enrollments: true } } },
  });

  if (!existing) throw notFound('Batch');

  if (input.capacity !== undefined && input.capacity < existing._count.enrollments) {
    throw unprocessable(
      `This batch already holds ${existing._count.enrollments} students. Move some out before reducing capacity.`,
    );
  }

  const after = await prisma.batch.update({
    where: { id: batchId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
      ...(input.room !== undefined ? { room: input.room } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      ...(input.endDate !== undefined ? { endDate: input.endDate } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });

  return { before: existing, after };
}

// ---------------------------------------------------------------- subjects --

export async function listSubjects(auth: AuthContext, args: ListArgs) {
  const where: Prisma.SubjectWhereInput = {
    instituteId: auth.instituteId,
    deletedAt: null,
    ...(args.isActive !== undefined ? { isActive: args.isActive } : {}),
    ...(args.search
      ? {
          OR: [
            { name: { contains: args.search, mode: 'insensitive' } },
            { code: { contains: args.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const { skip, take } = toSkipTake(args);

  const [items, total] = await Promise.all([
    prisma.subject.findMany({
      where,
      orderBy: safeOrderBy(args.sort, SUBJECT_SORTS, 'name', args.order),
      skip,
      take,
      select: {
        id: true,
        name: true,
        code: true,
        colorHex: true,
        iconKey: true,
        description: true,
        isActive: true,
        _count: { select: { topics: true, assignments: true } },
      },
    }),
    prisma.subject.count({ where }),
  ]);

  return { items, meta: buildPageMeta(args.page, args.pageSize, total) };
}

export async function createSubject(auth: AuthContext, input: {
  name: string;
  code: string;
  colorHex: string;
  iconKey: string;
  description?: string | undefined;
}) {
  const duplicate = await prisma.subject.findFirst({
    where: { instituteId: auth.instituteId, code: input.code },
    select: { id: true },
  });

  if (duplicate) throw conflict(`Subject code ${input.code} is already in use.`);

  return prisma.subject.create({
    data: {
      instituteId: auth.instituteId,
      name: input.name,
      code: input.code,
      colorHex: input.colorHex,
      iconKey: input.iconKey,
      description: input.description || null,
    },
  });
}

export async function updateSubject(
  auth: AuthContext,
  subjectId: string,
  input: Partial<{
    name: string;
    code: string;
    colorHex: string;
    iconKey: string;
    description: string;
    isActive: boolean;
  }>,
) {
  const existing = await prisma.subject.findFirst({
    where: { id: subjectId, instituteId: auth.instituteId, deletedAt: null },
  });

  if (!existing) throw notFound('Subject');

  const after = await prisma.subject.update({
    where: { id: subjectId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.colorHex !== undefined ? { colorHex: input.colorHex } : {}),
      ...(input.iconKey !== undefined ? { iconKey: input.iconKey } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });

  return { before: existing, after };
}

// ------------------------------------------------------------- enrollments --

export async function enrollStudents(
  auth: AuthContext,
  batchId: string,
  studentIds: string[],
  rollNumberPrefix?: string,
) {
  const batch = await prisma.batch.findFirst({
    where: { id: batchId, classGroup: { instituteId: auth.instituteId }, deletedAt: null },
    select: { id: true, capacity: true, _count: { select: { enrollments: true } } },
  });

  if (!batch) throw notFound('Batch');

  const students = await prisma.studentProfile.findMany({
    where: { id: { in: studentIds }, user: { instituteId: auth.instituteId, deletedAt: null } },
    select: { id: true },
  });

  if (students.length !== studentIds.length) {
    throw unprocessable('One or more students do not belong to this institute.');
  }

  const alreadyIn = await prisma.enrollment.findMany({
    where: { batchId, studentId: { in: studentIds } },
    select: { studentId: true },
  });

  const existingIds = new Set(alreadyIn.map((row) => row.studentId));
  const toAdd = studentIds.filter((id) => !existingIds.has(id));

  if (batch._count.enrollments + toAdd.length > batch.capacity) {
    throw unprocessable(
      `Adding ${toAdd.length} students would exceed the batch capacity of ${batch.capacity}.`,
    );
  }

  let nextRoll = batch._count.enrollments + 1;

  const created = await prisma.$transaction(
    toAdd.map((studentId) => {
      const rollNumber = rollNumberPrefix
        ? `${rollNumberPrefix}${String(nextRoll++).padStart(2, '0')}`
        : null;

      return prisma.enrollment.create({
        data: { studentId, batchId, rollNumber },
        select: { id: true, studentId: true, rollNumber: true },
      });
    }),
  );

  return { enrolled: created, skipped: [...existingIds] };
}

export async function updateEnrollment(
  auth: AuthContext,
  enrollmentId: string,
  input: { status: EnrollmentStatus; rollNumber?: string | null },
) {
  const existing = await prisma.enrollment.findFirst({
    where: {
      id: enrollmentId,
      batch: { classGroup: { instituteId: auth.instituteId } },
    },
    select: { id: true, status: true, studentId: true, batchId: true },
  });

  if (!existing) throw notFound('Enrollment');

  const after = await prisma.enrollment.update({
    where: { id: enrollmentId },
    data: {
      status: input.status,
      ...(input.rollNumber !== undefined ? { rollNumber: input.rollNumber } : {}),
      ...(input.status === EnrollmentStatus.DROPPED ||
      input.status === EnrollmentStatus.COMPLETED
        ? { leftAt: new Date() }
        : { leftAt: null }),
    },
  });

  return { before: existing, after };
}

// ------------------------------------------------------ teacher assignments --

export async function assignTeacher(
  auth: AuthContext,
  batchId: string,
  teacherId: string,
  subjectId: string,
  isPrimary: boolean,
) {
  const [batch, teacher, subject] = await Promise.all([
    prisma.batch.findFirst({
      where: { id: batchId, classGroup: { instituteId: auth.instituteId }, deletedAt: null },
      select: { id: true },
    }),
    prisma.teacherProfile.findFirst({
      where: { id: teacherId, user: { instituteId: auth.instituteId, deletedAt: null } },
      select: { id: true },
    }),
    prisma.subject.findFirst({
      where: { id: subjectId, instituteId: auth.instituteId, deletedAt: null },
      select: { id: true },
    }),
  ]);

  if (!batch) throw notFound('Batch');
  if (!teacher) throw notFound('Teacher');
  if (!subject) throw notFound('Subject');

  // One primary teacher per subject per batch, so "who owns this class" is
  // never ambiguous when the daily-log compliance report runs.
  if (isPrimary) {
    await prisma.teacherAssignment.updateMany({
      where: { batchId, subjectId, isPrimary: true },
      data: { isPrimary: false },
    });
  }

  return prisma.teacherAssignment.upsert({
    where: { teacherId_batchId_subjectId: { teacherId, batchId, subjectId } },
    update: { isPrimary },
    create: { teacherId, batchId, subjectId, isPrimary },
    select: {
      id: true,
      isPrimary: true,
      subject: { select: { id: true, name: true } },
      teacher: {
        select: { id: true, user: { select: { firstName: true, lastName: true } } },
      },
    },
  });
}

export async function removeAssignment(auth: AuthContext, assignmentId: string) {
  const existing = await prisma.teacherAssignment.findFirst({
    where: { id: assignmentId, batch: { classGroup: { instituteId: auth.instituteId } } },
    select: { id: true, teacherId: true, batchId: true, subjectId: true },
  });

  if (!existing) throw notFound('Assignment');

  await prisma.teacherAssignment.delete({ where: { id: assignmentId } });
  return existing;
}

/** Institute-wide counts. Safe for MANAGEMENT: no individual is identifiable. */
export async function academicOverview(auth: AuthContext) {
  const [classes, batches, subjects, students, teachers, parents, unassignedBatches] =
    await Promise.all([
      prisma.classGroup.count({
        where: { instituteId: auth.instituteId, deletedAt: null, isActive: true },
      }),
      prisma.batch.count({
        where: { classGroup: { instituteId: auth.instituteId }, deletedAt: null, isActive: true },
      }),
      prisma.subject.count({
        where: { instituteId: auth.instituteId, deletedAt: null, isActive: true },
      }),
      prisma.user.count({
        where: { instituteId: auth.instituteId, role: Role.STUDENT, deletedAt: null },
      }),
      prisma.user.count({
        where: { instituteId: auth.instituteId, role: Role.TEACHER, deletedAt: null },
      }),
      prisma.user.count({
        where: { instituteId: auth.instituteId, role: Role.PARENT, deletedAt: null },
      }),
      prisma.batch.count({
        where: {
          classGroup: { instituteId: auth.instituteId },
          deletedAt: null,
          isActive: true,
          teacherAssignment: { none: {} },
        },
      }),
    ]);

  return {
    classes,
    batches,
    subjects,
    students,
    teachers,
    parents,
    // Surfaced because an unstaffed batch is the single most common setup error.
    batchesWithoutTeacher: unassignedBatches,
  };
}
