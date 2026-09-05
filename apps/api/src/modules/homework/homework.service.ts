import { AssignmentKind, Prisma, Role, SubmissionStatus } from '@prisma/client';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/http-error';
import { prisma } from '../../lib/prisma';
import { batchVisibilityFilter, studentVisibilityFilter } from '../../lib/scope';
import type { AuthContext } from '../../types/express';

/**
 * Homework, assignments, projects and worksheets share one table and one
 * submission pipeline, distinguished by `kind`. Four near-identical tables would
 * have meant four grading paths and four places for a bug to hide.
 */
export async function listHomework(
  auth: AuthContext,
  args: {
    batchId?: string | undefined;
    subjectId?: string | undefined;
    kind?: AssignmentKind | undefined;
    isPublished?: boolean | undefined;
    limit: number;
  },
) {
  const where: Prisma.AssignmentWhereInput = {
    deletedAt: null,
    batch: batchVisibilityFilter(auth),
    ...(args.batchId ? { batchId: args.batchId } : {}),
    ...(args.subjectId ? { subjectId: args.subjectId } : {}),
    ...(args.kind ? { kind: args.kind } : {}),
    ...(args.isPublished !== undefined ? { isPublished: args.isPublished } : {}),
  };

  if (auth.role === Role.STUDENT || auth.role === Role.PARENT) {
    where.isPublished = true;
  }

  const items = await prisma.assignment.findMany({
    where,
    orderBy: { dueAt: 'desc' },
    take: args.limit,
    select: {
      id: true,
      kind: true,
      title: true,
      instructions: true,
      maxMarks: true,
      dueAt: true,
      allowLate: true,
      latePenaltyPct: true,
      isPublished: true,
      batch: { select: { id: true, name: true } },
      subject: { select: { id: true, name: true, colorHex: true } },
      teacher: { select: { id: true, user: { select: { firstName: true, lastName: true } } } },
      _count: { select: { submissions: true } },
      ...(auth.role === Role.STUDENT && auth.profileId
        ? {
            submissions: {
              where: { studentId: auth.profileId },
              select: { id: true, status: true, submittedAt: true, marksAwarded: true, isLate: true },
            },
          }
        : {}),
    },
  });

  return items;
}

export async function createHomework(
  auth: AuthContext,
  input: {
    batchId: string;
    subjectId: string;
    kind: AssignmentKind;
    title: string;
    instructions: string;
    maxMarks: number;
    dueAt: Date;
    allowLate: boolean;
    latePenaltyPct: number;
    publishNow: boolean;
  },
) {
  const batch = await prisma.batch.findFirst({
    where: { AND: [{ id: input.batchId }, batchVisibilityFilter(auth)] },
    select: { id: true },
  });
  if (!batch) throw forbidden('You are not assigned to that batch.');

  if (input.dueAt <= new Date()) {
    throw unprocessable('The due date has already passed.');
  }

  const teacherId =
    auth.role === Role.TEACHER
      ? auth.profileId
      : (
          await prisma.teacherAssignment.findFirst({
            where: { batchId: input.batchId, subjectId: input.subjectId },
            select: { teacherId: true },
          })
        )?.teacherId;

  if (!teacherId) throw unprocessable('No teacher is assigned to that subject for this batch.');

  return prisma.assignment.create({
    data: {
      batchId: input.batchId,
      subjectId: input.subjectId,
      teacherId,
      kind: input.kind,
      title: input.title,
      instructions: input.instructions,
      maxMarks: input.maxMarks,
      dueAt: input.dueAt,
      allowLate: input.allowLate,
      latePenaltyPct: input.latePenaltyPct,
      isPublished: input.publishNow,
      publishedAt: input.publishNow ? new Date() : null,
    },
  });
}

export async function submitHomework(
  auth: AuthContext,
  assignmentId: string,
  contentText: string | undefined,
  asDraft: boolean,
) {
  if (auth.role !== Role.STUDENT || !auth.profileId) {
    throw forbidden('Only a student can submit work.');
  }

  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId, deletedAt: null, isPublished: true },
    select: { id: true, batchId: true, dueAt: true, allowLate: true },
  });

  if (!assignment) throw notFound('Assignment');

  const enrolled = await prisma.enrollment.findFirst({
    where: { batchId: assignment.batchId, studentId: auth.profileId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!enrolled) throw forbidden('You are not enrolled in that batch.');

  const existing = await prisma.assignmentSubmission.findUnique({
    where: { assignmentId_studentId: { assignmentId, studentId: auth.profileId } },
    select: { id: true, status: true },
  });

  if (
    existing &&
    (existing.status === SubmissionStatus.GRADED || existing.status === SubmissionStatus.RETURNED)
  ) {
    throw conflict('This work has already been marked and cannot be resubmitted.');
  }

  const now = new Date();
  const isLate = now > assignment.dueAt;

  if (isLate && !assignment.allowLate && !asDraft) {
    throw unprocessable('The deadline has passed and late submissions are not accepted.');
  }

  const status = asDraft
    ? SubmissionStatus.DRAFT
    : isLate
      ? SubmissionStatus.LATE
      : SubmissionStatus.SUBMITTED;

  return prisma.assignmentSubmission.upsert({
    where: { assignmentId_studentId: { assignmentId, studentId: auth.profileId } },
    update: {
      contentText: contentText ?? null,
      status,
      submittedAt: asDraft ? null : now,
      isLate: asDraft ? false : isLate,
    },
    create: {
      assignmentId,
      studentId: auth.profileId,
      contentText: contentText ?? null,
      status,
      submittedAt: asDraft ? null : now,
      isLate: asDraft ? false : isLate,
    },
    select: { id: true, status: true, submittedAt: true, isLate: true },
  });
}

/** The teacher's marking queue for one assignment, with non-submitters listed. */
export async function submissionQueue(auth: AuthContext, assignmentId: string) {
  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId, deletedAt: null, batch: batchVisibilityFilter(auth) },
    select: { id: true, title: true, maxMarks: true, dueAt: true, batchId: true, teacherId: true },
  });

  if (!assignment) throw notFound('Assignment');

  const enrollments = await prisma.enrollment.findMany({
    where: { batchId: assignment.batchId, status: 'ACTIVE' },
    orderBy: { rollNumber: 'asc' },
    select: {
      rollNumber: true,
      student: {
        select: { id: true, user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  const submissions = await prisma.assignmentSubmission.findMany({
    where: { assignmentId },
    select: {
      id: true,
      studentId: true,
      status: true,
      submittedAt: true,
      isLate: true,
      contentText: true,
      marksAwarded: true,
      feedback: true,
    },
  });

  const byStudent = new Map(submissions.map((s) => [s.studentId, s]));

  return {
    assignment,
    rows: enrollments.map((row) => ({
      studentId: row.student.id,
      rollNumber: row.rollNumber,
      name: `${row.student.user.firstName} ${row.student.user.lastName}`,
      // Explicitly null rather than omitted: "has not submitted" is information
      // the teacher needs, not an absence of information.
      submission: byStudent.get(row.student.id) ?? null,
    })),
  };
}

export async function gradeSubmission(
  auth: AuthContext,
  submissionId: string,
  input: { marksAwarded: number; feedback: string; status: SubmissionStatus },
) {
  const submission = await prisma.assignmentSubmission.findFirst({
    where: {
      id: submissionId,
      assignment: { batch: { classGroup: { instituteId: auth.instituteId } } },
    },
    select: {
      id: true,
      isLate: true,
      marksAwarded: true,
      assignment: { select: { maxMarks: true, latePenaltyPct: true, teacherId: true } },
    },
  });

  if (!submission) throw notFound('Submission');

  if (auth.role === Role.TEACHER && submission.assignment.teacherId !== auth.profileId) {
    throw forbidden('You can only mark your own assignments.');
  }

  if (input.marksAwarded > submission.assignment.maxMarks) {
    throw unprocessable(`This assignment is out of ${submission.assignment.maxMarks}.`);
  }

  // The penalty is applied once, at grading, and the teacher marks the work on
  // its merits. Applying it earlier would hide the real quality of the answer.
  const penalty =
    submission.isLate && submission.assignment.latePenaltyPct > 0
      ? input.marksAwarded * (submission.assignment.latePenaltyPct / 100)
      : 0;

  const finalMarks = Math.round((input.marksAwarded - penalty) * 100) / 100;

  const graded = await prisma.assignmentSubmission.update({
    where: { id: submissionId },
    data: {
      marksAwarded: finalMarks,
      feedback: input.feedback,
      status: input.status,
      gradedById: auth.userId,
      gradedAt: new Date(),
    },
    select: { id: true, marksAwarded: true, status: true, isLate: true },
  });

  return { ...graded, rawMarks: input.marksAwarded, latePenaltyApplied: penalty };
}

/** A student's own homework record, used by their dashboard and by parents. */
export async function studentHomework(auth: AuthContext, studentId: string) {
  const visible = await prisma.studentProfile.findFirst({
    where: { AND: [{ id: studentId }, studentVisibilityFilter(auth)] },
    select: { id: true },
  });

  if (!visible) throw forbidden('You do not have access to this student.');

  const submissions = await prisma.assignmentSubmission.findMany({
    where: { studentId },
    orderBy: { assignment: { dueAt: 'desc' } },
    take: 100,
    select: {
      id: true,
      status: true,
      submittedAt: true,
      isLate: true,
      marksAwarded: true,
      feedback: true,
      assignment: {
        select: {
          id: true,
          title: true,
          kind: true,
          maxMarks: true,
          dueAt: true,
          subject: { select: { name: true, colorHex: true } },
        },
      },
    },
  });

  const graded = submissions.filter((s) => s.marksAwarded !== null);
  const totalAwarded = graded.reduce((sum, s) => sum + (s.marksAwarded ?? 0), 0);
  const totalPossible = graded.reduce((sum, s) => sum + s.assignment.maxMarks, 0);

  return {
    submissions,
    summary: {
      total: submissions.length,
      submitted: submissions.filter((s) => s.submittedAt !== null).length,
      late: submissions.filter((s) => s.isLate).length,
      graded: graded.length,
      averagePct: totalPossible > 0 ? Math.round((totalAwarded / totalPossible) * 100) : null,
    },
  };
}
