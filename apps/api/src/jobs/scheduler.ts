import { SessionStatus } from '@prisma/client';
import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { addDays, nowInZone, toDateString, toUtcDate } from '../lib/time';
import { sweepOverdueLogs } from '../modules/dailylogs/dailylogs.service';
import { loadConfiguration, sweepMissedSessions } from '../modules/selfstudy/selfstudy.service';
import { planSelfStudy, type LectureContext } from '../modules/selfstudy/selfstudy.engine';
import { sweepOverdue } from '../modules/fees/fees.service';
import { flushScheduled } from '../modules/notifications/notifications.service';
import { generateSessions } from '../modules/timetable/timetable.service';
import type { AuthContext } from '../types/express';

const TZ = env.TZ;

/**
 * Background jobs run as the institute rather than as a person, so they get a
 * synthetic context with the permissions they need and nothing else. Using a
 * real admin's identity here would attribute automated writes to a human in the
 * audit log, which is worse than useless when tracing a problem.
 */
function systemContext(instituteId: string): AuthContext {
  return {
    userId: '00000000-0000-0000-0000-000000000000',
    instituteId,
    role: 'ADMIN',
    email: 'system@internal',
    sessionId: 'system',
    permissions: new Set(['timetable.manage', 'ai.tasks.generate']),
    profileId: null,
    aggregateOnly: false,
  };
}

/** Keeps two weeks of class sessions materialised ahead of today. */
export async function rollForwardSessions(): Promise<void> {
  const institutes = await prisma.institute.findMany({
    where: { isActive: true },
    select: { id: true, code: true },
  });

  for (const institute of institutes) {
    const { date } = nowInZone(TZ);

    try {
      const report = await generateSessions(systemContext(institute.id), {
        from: date,
        to: addDays(date, 14),
        reconcile: true,
      });

      if (report.created > 0 || report.reconciled > 0) {
        logger.info(
          { institute: institute.code, ...report },
          'class sessions rolled forward',
        );
      }
    } catch (error) {
      logger.error({ err: error, institute: institute.code }, 'session roll-forward failed');
    }
  }
}

/**
 * Schedules self-study for lectures that finished today and have no study
 * session attached yet. The teacher can trigger this by hand; this catch-up
 * pass exists so a lecture nobody pressed a button for still produces work.
 */
export async function scheduleTodaysSelfStudy(): Promise<void> {
  const institutes = await prisma.institute.findMany({
    where: { isActive: true },
    select: { id: true, code: true },
  });

  for (const institute of institutes) {
    const { date } = nowInZone(TZ);

    try {
      const { policy, rules } = await loadConfiguration(institute.id);

      const sessions = await prisma.classSession.findMany({
        where: {
          sessionDate: toUtcDate(date),
          status: { in: [SessionStatus.COMPLETED, SessionStatus.ONGOING] },
          batch: { classGroup: { instituteId: institute.id } },
          selfStudySessions: { none: {} },
        },
        select: {
          id: true,
          batchId: true,
          sessionDate: true,
          startTimeMin: true,
          endTimeMin: true,
        },
      });

      let planned = 0;

      for (const session of sessions) {
        const lecture: LectureContext = {
          classSessionId: session.id,
          batchId: session.batchId,
          sessionDate: toDateString(session.sessionDate),
          startTimeMin: session.startTimeMin,
          endTimeMin: session.endTimeMin,
        };

        const plan = planSelfStudy(lecture, rules, policy);
        if (!plan.scheduled) continue;

        const enrollments = await prisma.enrollment.findMany({
          where: { batchId: session.batchId, status: 'ACTIVE' },
          select: { studentId: true },
        });

        for (const enrollment of enrollments) {
          await prisma.selfStudySession
            .upsert({
              where: {
                studentId_studyDate_plannedStartMin: {
                  studentId: enrollment.studentId,
                  studyDate: toUtcDate(plan.studyDate),
                  plannedStartMin: plan.plannedStartMin,
                },
              },
              update: {},
              create: {
                studentId: enrollment.studentId,
                ruleId: plan.ruleId,
                classSessionId: session.id,
                studyDate: toUtcDate(plan.studyDate),
                plannedStartMin: plan.plannedStartMin,
                plannedEndMin: plan.plannedEndMin,
                durationMin: plan.durationMin,
              },
            })
            .then(() => {
              planned += 1;
            })
            .catch(() => undefined);
        }
      }

      if (planned > 0) {
        logger.info({ institute: institute.code, planned }, 'self-study catch-up complete');
      }
    } catch (error) {
      logger.error({ err: error, institute: institute.code }, 'self-study catch-up failed');
    }
  }
}

/** Closes yesterday's books: missed study sessions and unfiled daily logs. */
export async function nightlySweep(): Promise<void> {
  try {
    const { date } = nowInZone(TZ);
    const [missed, overdue] = await Promise.all([
      sweepMissedSessions(date),
      sweepOverdueLogs(),
    ]);

    if (missed > 0 || overdue > 0) {
      logger.info({ missedSelfStudy: missed, missingDailyLogs: overdue }, 'nightly sweep complete');
    }
  } catch (error) {
    logger.error({ err: error }, 'nightly sweep failed');
  }
}

/** Delivers anything held back by quiet hours whose time has now come. */
export async function deliverQueuedNotifications(): Promise<void> {
  try {
    const delivered = await flushScheduled();
    if (delivered > 0) logger.info({ delivered }, 'queued notifications delivered');
  } catch (error) {
    logger.error({ err: error }, 'notification flush failed');
  }
}

/** Marks invoices overdue once their due date has passed. */
export async function markOverdueInvoices(): Promise<void> {
  try {
    const marked = await sweepOverdue();
    if (marked > 0) logger.info({ marked }, 'invoices marked overdue');
  } catch (error) {
    logger.error({ err: error }, 'overdue sweep failed');
  }
}

let tasks: ScheduledTask[] = [];

/**
 * Every schedule below is expressed in the institute's timezone, not the
 * server's. On Render the process runs in UTC unless TZ is set, and a job
 * meant for 22:00 IST would otherwise fire at 03:30 IST.
 */
export function startScheduler(): void {
  if (tasks.length > 0) return;

  const options = { timezone: TZ };

  // 01:00 — after the blackout begins, so nothing in progress is disturbed.
  tasks.push(cron.schedule('0 1 * * *', () => void nightlySweep(), options));

  // 02:00 — keep the next fortnight of class sessions materialised.
  tasks.push(cron.schedule('0 2 * * *', () => void rollForwardSessions(), options));

  // Hourly between 16:00 and 21:00 — catch lectures whose study was never
  // generated, while there is still an evening left to study in.
  tasks.push(
    cron.schedule('0 16-21 * * *', () => void scheduleTodaysSelfStudy(), options),
  );

  // Every five minutes: release notifications held by quiet hours.
  tasks.push(cron.schedule('*/5 * * * *', () => void deliverQueuedNotifications(), options));

  // 03:00 — recompute overdue invoices before anyone reads a dashboard.
  tasks.push(cron.schedule('0 3 * * *', () => void markOverdueInvoices(), options));

  logger.info({ jobs: tasks.length, timezone: TZ }, 'scheduler started');
}

export function stopScheduler(): void {
  for (const task of tasks) task.stop();
  tasks = [];
}
