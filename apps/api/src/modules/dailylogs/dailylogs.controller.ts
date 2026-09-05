import { AuditAction, Role } from '@prisma/client';
import type { Request, Response } from 'express';
import { created, ok } from '../../lib/api-response';
import { recordAudit } from '../../lib/audit';
import { unprocessable } from '../../lib/http-error';
import { requireContext } from '../../middleware/authorize';
import { complianceReportSchema, listLogsSchema, submitLogSchema } from './dailylogs.schemas';
import * as service from './dailylogs.service';

export async function submitHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = submitLogSchema.parse(req.body);
  const sessionId = req.params.sessionId ?? '';

  const { log, wasEdit } = await service.submitLog(auth, sessionId, input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'TeacherDailyLog',
    entityId: log.id,
    summary: `${wasEdit ? 'Edited' : 'Filed'} the daily log for "${log.topic}" (${log.compliance})`,
    after: log,
  });

  return wasEdit ? ok(res, { log }) : created(res, { log });
}

export async function listHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = listLogsSchema.parse(req.query);
  const logs = await service.listLogs(auth, query);
  return ok(res, { logs });
}

export async function outstandingHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const requested = typeof req.query.teacherId === 'string' ? req.query.teacherId : null;

  const teacherId = auth.role === Role.TEACHER ? auth.profileId : requested;
  if (!teacherId) {
    throw unprocessable('Pass a teacherId, or call this as a teacher.');
  }

  const outstanding = await service.outstandingForTeacher(auth, teacherId);
  return ok(res, { teacherId, outstanding });
}

export async function complianceHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = complianceReportSchema.parse(req.query);
  const report = await service.complianceReport(auth, query);
  return ok(res, report);
}
