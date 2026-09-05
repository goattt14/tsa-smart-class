import { AuditAction } from '@prisma/client';
import type { Request, Response } from 'express';
import { ok } from '../../lib/api-response';
import { recordAudit } from '../../lib/audit';
import { requireContext } from '../../middleware/authorize';
import {
  attendanceReportSchema,
  correctAttendanceSchema,
  markAttendanceSchema,
} from './attendance.schemas';
import * as service from './attendance.service';

export async function rosterHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const roster = await service.getSessionRoster(auth, req.params.sessionId ?? '');
  return ok(res, roster);
}

export async function markHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = markAttendanceSchema.parse(req.body);
  const sessionId = req.params.sessionId ?? '';

  const report = await service.markAttendance(
    auth,
    sessionId,
    input.entries,
    input.defaultRemainingToPresent,
  );

  await recordAudit(req, {
    action: AuditAction.ATTENDANCE_MARKED,
    entityType: 'ClassSession',
    entityId: sessionId,
    summary: `Marked attendance: ${report.counts.PRESENT} present, ${report.counts.ABSENT} absent, ${report.counts.LATE} late, ${report.counts.EXCUSED} excused`,
    after: report.counts,
  });

  return ok(res, report);
}

export async function correctHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = correctAttendanceSchema.parse(req.body);
  const { before, after } = await service.correctAttendance(
    auth,
    req.params.attendanceId ?? '',
    input,
  );

  await recordAudit(req, {
    action: AuditAction.ATTENDANCE_UPDATED,
    entityType: 'Attendance',
    entityId: after.id,
    summary: `Corrected ${before.status} to ${after.status}: ${input.reason}`,
    before,
    after,
  });

  return ok(res, { attendance: after });
}

export async function reportHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = attendanceReportSchema.parse(req.query);
  const report = await service.attendanceReport(auth, query);
  return ok(res, report);
}

export async function trendHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = attendanceReportSchema.parse(req.query);
  const trend = await service.attendanceTrend(auth, query.from, query.to);
  return ok(res, { from: query.from, to: query.to, trend });
}
