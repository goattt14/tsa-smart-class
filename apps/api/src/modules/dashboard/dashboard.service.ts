import { AttendanceStatus, ComplianceStatus, Role, SessionStatus } from '@prisma/client';
import { forbidden } from '../../lib/http-error';
import { prisma } from '../../lib/prisma';
import { studentVisibilityFilter } from '../../lib/scope';
import { addDays, nowInZone, toDateString, toUtcDate } from '../../lib/time';
import type { AuthContext } from '../../types/express';
import { complianceReport } from '../dailylogs/dailylogs.service';
import { collectionSummary } from '../fees/fees.service';

const TZ = process.env.TZ ?? 'Asia/Kolkata';

/**
 * One endpoint per role, rather than a generic one the client assembles.
 *
 * A dashboard built from eight separate calls is eight round trips on a phone
 * on Indian mobile data, and eight chances for one to fail and leave the screen
 * half-rendered. Each of these returns everything one screen needs.
 *
 * Every figure is computed from real rows. Nothing here is a placeholder or a
 * hardcoded number.
 */

export async function studentDashboard(auth: AuthContext, studentId: string) {
  const student = await prisma.studentProfile.findFirst({
    where: { AND: [{ id: studentId }, studentVisibilityFilter(auth)] },
    select: {
      id: true,
      admissionNumber: true,
      user: { select: { firstName: true, lastName: true, avatarUrl: true } },
      enrollments: {
        where: { status: 'ACTIVE' },
        select: { batch: { select: { id: true, name: true } } },
      },
    },
  });

  if (!student) throw forbidden('You do not have access to this student.');

  const { date, minutes } = nowInZone(TZ);
  const batchIds = student.enrollments.map((e) => e.batch.id);

  const [todayClasses, selfStudy, pendingHomework, upcomingTests, recentEvaluations, attendance, recommendations, unread] =
    await Promise.all([
      prisma.classSession.findMany({
        where: { batchId: { in: batchIds }, sessionDate: toUtcDate(date) },
        orderBy: { startTimeMin: 'asc' },
        select: {
          id: true,
          startTimeMin: true,
          endTimeMin: true,
          room: true,
          status: true,
          subject: { select: { name: true, colorHex: true } },
          teacher: { select: { user: { select: { firstName: true, lastName: true } } } },
        },
      }),

      prisma.selfStudySession.findMany({
        where: { studentId, studyDate: toUtcDate(date) },
        orderBy: { plannedStartMin: 'asc' },
        select: {
          id: true,
          plannedStartMin: true,
          plannedEndMin: true,
          status: true,
          completionPct: true,
          classSession: { select: { subject: { select: { name: true, colorHex: true } } } },
        },
      }),

      prisma.assignment.findMany({
        where: {
          batchId: { in: batchIds },
          isPublished: true,
          deletedAt: null,
          dueAt: { gte: new Date() },
          submissions: { none: { studentId, status: { in: ['SUBMITTED', 'LATE', 'GRADED'] } } },
        },
        orderBy: { dueAt: 'asc' },
        take: 5,
        select: {
          id: true,
          title: true,
          kind: true,
          dueAt: true,
          maxMarks: true,
          subject: { select: { name: true, colorHex: true } },
        },
      }),

      prisma.test.findMany({
        where: {
          batchId: { in: batchIds },
          isPublished: true,
          deletedAt: null,
          scheduledAt: { gte: new Date() },
        },
        orderBy: { scheduledAt: 'asc' },
        take: 3,
        select: {
          id: true,
          title: true,
          scheduledAt: true,
          durationMin: true,
          maxMarks: true,
          subject: { select: { name: true, colorHex: true } },
        },
      }),

      // The last few pieces of feedback, because "what did I get wrong
      // yesterday" is the question a student actually opens the app to answer.
      prisma.aiEvaluation.findMany({
        where: { practiceAnswer: { practiceQuestion: { practiceSession: { studentId } } } },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: {
          id: true,
          score: true,
          maxScore: true,
          verdict: true,
          whatWentRight: true,
          improvementTip: true,
          createdAt: true,
        },
      }),

      prisma.attendance.groupBy({
        by: ['status'],
        where: { studentId, classSession: { sessionDate: { gte: toUtcDate(addDays(date, -30)) } } },
        _count: { _all: true },
      }),

      prisma.learningRecommendation.findMany({
        where: { studentId, isDismissed: false },
        orderBy: { priority: 'asc' },
        take: 4,
        select: {
          id: true,
          kind: true,
          title: true,
          reason: true,
          topic: { select: { id: true, name: true } },
        },
      }),

      prisma.notification.count({
        where: { userId: auth.userId, readAt: null, channel: 'IN_APP', status: { in: ['SENT', 'DELIVERED'] } },
      }),
    ]);

  const counts = Object.fromEntries(attendance.map((row) => [row.status, row._count._all]));
  const present = (counts[AttendanceStatus.PRESENT] ?? 0) + (counts[AttendanceStatus.LATE] ?? 0);
  const counted = present + (counts[AttendanceStatus.ABSENT] ?? 0);

  return {
    student: {
      id: student.id,
      name: `${student.user.firstName} ${student.user.lastName}`,
      admissionNumber: student.admissionNumber,
      avatarUrl: student.user.avatarUrl,
      batches: student.enrollments.map((e) => e.batch),
    },
    today: { date, nowMinutes: minutes, classes: todayClasses, selfStudy },
    pendingHomework,
    upcomingTests,
    recentFeedback: recentEvaluations,
    attendance30Day: {
      attendancePct: counted > 0 ? Math.round((present / counted) * 100) : null,
      present,
      absent: counts[AttendanceStatus.ABSENT] ?? 0,
      counted,
    },
    recommendations,
    unreadNotifications: unread,
  };
}

export async function teacherDashboard(auth: AuthContext) {
  if (!auth.profileId) throw forbidden('This view is for teachers.');

  const { date } = nowInZone(TZ);
  const teacherId = auth.profileId;

  const [todaySessions, outstandingLogs, gradingQueue, pendingAiReview, batches, unread] =
    await Promise.all([
      prisma.classSession.findMany({
        where: { teacherId, sessionDate: toUtcDate(date) },
        orderBy: { startTimeMin: 'asc' },
        select: {
          id: true,
          startTimeMin: true,
          endTimeMin: true,
          room: true,
          status: true,
          batch: { select: { id: true, name: true } },
          subject: { select: { name: true, colorHex: true } },
          dailyLog: { select: { id: true, compliance: true } },
          _count: { select: { attendance: true } },
        },
      }),

      prisma.classSession.count({
        where: {
          teacherId,
          status: { in: [SessionStatus.COMPLETED, SessionStatus.ONGOING] },
          dailyLog: { is: null },
        },
      }),

      prisma.assignmentSubmission.count({
        where: {
          assignment: { teacherId },
          status: { in: ['SUBMITTED', 'LATE'] },
          marksAwarded: null,
        },
      }),

      prisma.aiTask.count({
        where: { status: 'PENDING_REVIEW', batch: { teacherAssignment: { some: { teacherId } } } },
      }),

      prisma.teacherAssignment.findMany({
        where: { teacherId },
        select: {
          batch: {
            select: {
              id: true,
              name: true,
              _count: { select: { enrollments: true } },
            },
          },
          subject: { select: { id: true, name: true, colorHex: true } },
        },
      }),

      prisma.notification.count({
        where: { userId: auth.userId, readAt: null, channel: 'IN_APP', status: { in: ['SENT', 'DELIVERED'] } },
      }),
    ]);

  const myCompliance = await complianceReport(auth, {
    from: addDays(date, -30),
    to: date,
    teacherId,
  });

  return {
    today: { date, sessions: todaySessions },
    actionsNeeded: {
      // The three things a teacher is behind on, surfaced as numbers rather
      // than buried in three separate screens.
      dailyLogsOutstanding: outstandingLogs,
      submissionsToGrade: gradingQueue,
      aiTasksAwaitingReview: pendingAiReview,
    },
    myCompliancePct: myCompliance.teachers[0]?.compliancePct ?? 100,
    batches: batches.map((row) => ({
      batchId: row.batch.id,
      batchName: row.batch.name,
      studentCount: row.batch._count.enrollments,
      subject: row.subject,
    })),
    unreadNotifications: unread,
  };
}

export async function parentDashboard(auth: AuthContext) {
  if (!auth.profileId) throw forbidden('This view is for parents.');

  const links = await prisma.parentStudentLink.findMany({
    where: { parentId: auth.profileId },
    select: {
      canViewFees: true,
      canViewReport: true,
      relation: true,
      student: {
        select: {
          id: true,
          admissionNumber: true,
          user: { select: { firstName: true, lastName: true, avatarUrl: true } },
        },
      },
    },
  });

  const { date } = nowInZone(TZ);

  const children = await Promise.all(
    links.map(async (link) => {
      const studentId = link.student.id;

      const [attendance, recentResults, homework, fees] = await Promise.all([
        prisma.attendance.groupBy({
          by: ['status'],
          where: {
            studentId,
            classSession: { sessionDate: { gte: toUtcDate(addDays(date, -30)) } },
          },
          _count: { _all: true },
        }),

        // Only published results. A parent must not see a mark before the
        // teacher has released it to the student.
        link.canViewReport
          ? prisma.testAttempt.findMany({
              where: { studentId, status: 'EVALUATED', test: { resultsPublished: true } },
              orderBy: { submittedAt: 'desc' },
              take: 3,
              select: {
                id: true,
                percentage: true,
                rank: true,
                test: { select: { title: true, maxMarks: true, subject: { select: { name: true } } } },
              },
            })
          : Promise.resolve([]),

        prisma.assignmentSubmission.groupBy({
          by: ['status'],
          where: { studentId },
          _count: { _all: true },
        }),

        link.canViewFees
          ? prisma.feeInvoice.aggregate({
              where: { studentId, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
              _count: { _all: true },
            })
          : Promise.resolve(null),
      ]);

      const counts = Object.fromEntries(attendance.map((row) => [row.status, row._count._all]));
      const present = (counts[AttendanceStatus.PRESENT] ?? 0) + (counts[AttendanceStatus.LATE] ?? 0);
      const counted = present + (counts[AttendanceStatus.ABSENT] ?? 0);

      const submitted =
        homework.find((row) => row.status === 'SUBMITTED')?._count._all ??
        0;
      const graded = homework.find((row) => row.status === 'GRADED')?._count._all ?? 0;

      return {
        student: {
          id: studentId,
          name: `${link.student.user.firstName} ${link.student.user.lastName}`,
          admissionNumber: link.student.admissionNumber,
          avatarUrl: link.student.user.avatarUrl,
          relation: link.relation,
        },
        canViewFees: link.canViewFees,
        canViewReport: link.canViewReport,
        attendancePct: counted > 0 ? Math.round((present / counted) * 100) : null,
        recentResults,
        homeworkSubmitted: submitted + graded,
        pendingInvoices: fees?._count._all ?? 0,
      };
    }),
  );

  return { children };
}

export async function adminDashboard(auth: AuthContext) {
  const { date } = nowInZone(TZ);

  const [users, todaySessions, attendanceToday, logCompliance, collection, aiUsage] =
    await Promise.all([
      prisma.user.groupBy({
        by: ['role'],
        where: { instituteId: auth.instituteId, deletedAt: null, status: 'ACTIVE' },
        _count: { _all: true },
      }),

      prisma.classSession.count({
        where: {
          sessionDate: toUtcDate(date),
          batch: { classGroup: { instituteId: auth.instituteId } },
        },
      }),

      prisma.attendance.groupBy({
        by: ['status'],
        where: {
          classSession: {
            sessionDate: toUtcDate(date),
            batch: { classGroup: { instituteId: auth.instituteId } },
          },
        },
        _count: { _all: true },
      }),

      prisma.teacherDailyLog.groupBy({
        by: ['compliance'],
        where: { classSession: { sessionDate: { gte: toUtcDate(addDays(date, -7)) } } },
        _count: { _all: true },
      }),

      collectionSummary(auth),

      prisma.aiUsageLog.aggregate({
        where: { createdAt: { gte: toUtcDate(date) } },
        _sum: { totalTokens: true },
        _count: { _all: true },
      }),
    ]);

  const attendanceCounts = Object.fromEntries(
    attendanceToday.map((row) => [row.status, row._count._all]),
  );
  const present =
    (attendanceCounts[AttendanceStatus.PRESENT] ?? 0) + (attendanceCounts[AttendanceStatus.LATE] ?? 0);
  const counted = present + (attendanceCounts[AttendanceStatus.ABSENT] ?? 0);

  const missing = logCompliance.find((row) => row.compliance === ComplianceStatus.MISSING)?._count._all ?? 0;

  return {
    date,
    people: Object.fromEntries(users.map((row) => [row.role, row._count._all])),
    today: {
      classesScheduled: todaySessions,
      attendanceMarked: counted,
      attendancePct: counted > 0 ? Math.round((present / counted) * 100) : null,
    },
    dailyLogs7Day: { missing, byStatus: logCompliance },
    fees: collection,
    aiToday: {
      calls: aiUsage._count._all,
      tokens: aiUsage._sum.totalTokens ?? 0,
    },
  };
}

/**
 * The management view.
 *
 * Aggregate only, by design. Every figure here is a count or a percentage over
 * the institute; no query in this function can return a named student, which is
 * what makes it safe to serve to an aggregate-only account.
 */
export async function managementDashboard(auth: AuthContext) {
  const { date } = nowInZone(TZ);
  const monthAgo = addDays(date, -30);

  const [enrolment, attendance, compliance, results, collection, selfStudy] = await Promise.all([
    prisma.user.groupBy({
      by: ['role'],
      where: { instituteId: auth.instituteId, deletedAt: null, status: 'ACTIVE' },
      _count: { _all: true },
    }),

    prisma.attendance.groupBy({
      by: ['status'],
      where: {
        classSession: {
          sessionDate: { gte: toUtcDate(monthAgo) },
          batch: { classGroup: { instituteId: auth.instituteId } },
        },
      },
      _count: { _all: true },
    }),

    complianceReport(auth, { from: monthAgo, to: date }),

    prisma.testAttempt.aggregate({
      where: {
        status: 'EVALUATED',
        submittedAt: { gte: toUtcDate(monthAgo) },
        test: { batch: { classGroup: { instituteId: auth.instituteId } } },
      },
      _avg: { percentage: true },
      _count: { _all: true },
    }),

    collectionSummary(auth),

    prisma.selfStudySession.groupBy({
      by: ['status'],
      where: {
        studyDate: { gte: toUtcDate(monthAgo) },
        student: { user: { instituteId: auth.instituteId } },
      },
      _count: { _all: true },
    }),
  ]);

  const attendanceCounts = Object.fromEntries(
    attendance.map((row) => [row.status, row._count._all]),
  );
  const present =
    (attendanceCounts[AttendanceStatus.PRESENT] ?? 0) + (attendanceCounts[AttendanceStatus.LATE] ?? 0);
  const counted = present + (attendanceCounts[AttendanceStatus.ABSENT] ?? 0);

  const completed = selfStudy.find((row) => row.status === 'COMPLETED')?._count._all ?? 0;
  const totalStudy = selfStudy.reduce((sum, row) => sum + row._count._all, 0);

  const worstCompliance = compliance.teachers.slice(0, 5).map((teacher) => ({
    // Teachers are staff, and naming them in a management report is
    // appropriate; no student appears anywhere in this response.
    name: teacher.name,
    compliancePct: teacher.compliancePct,
    missing: teacher.missing,
  }));

  return {
    windowDays: 30,
    enrolment: Object.fromEntries(enrolment.map((row) => [row.role, row._count._all])),
    attendancePct: counted > 0 ? Math.round((present / counted) * 100) : null,
    teacherCompliance: {
      averagePct:
        compliance.teachers.length > 0
          ? Math.round(
              compliance.teachers.reduce((sum, t) => sum + t.compliancePct, 0) /
                compliance.teachers.length,
            )
          : 100,
      lowest: worstCompliance,
    },
    academic: {
      averageTestPct: results._avg.percentage ? Math.round(results._avg.percentage * 10) / 10 : null,
      attemptsEvaluated: results._count._all,
    },
    selfStudy: {
      sessionsPlanned: totalStudy,
      completionPct: totalStudy > 0 ? Math.round((completed / totalStudy) * 100) : null,
    },
    fees: collection,
  };
}

/** Routes the caller to the right dashboard for their role. */
export async function dashboardFor(auth: AuthContext, studentId?: string) {
  switch (auth.role) {
    case Role.STUDENT:
      return { role: auth.role, data: await studentDashboard(auth, auth.profileId ?? '') };
    case Role.TEACHER:
      return { role: auth.role, data: await teacherDashboard(auth) };
    case Role.PARENT:
      return { role: auth.role, data: await parentDashboard(auth) };
    case Role.MANAGEMENT:
      return { role: auth.role, data: await managementDashboard(auth) };
    case Role.ADMIN:
      return studentId
        ? { role: auth.role, data: await studentDashboard(auth, studentId) }
        : { role: auth.role, data: await adminDashboard(auth) };
    default:
      throw forbidden('No dashboard is defined for this role.');
  }
}
