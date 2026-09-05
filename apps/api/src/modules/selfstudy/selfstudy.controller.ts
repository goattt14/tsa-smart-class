import { AuditAction, Role } from '@prisma/client';
import type { Request, Response } from 'express';
import { created, noContent, ok } from '../../lib/api-response';
import { recordAudit } from '../../lib/audit';
import { unprocessable } from '../../lib/http-error';
import { requireContext } from '../../middleware/authorize';
import {
  createRuleSchema,
  generateSchema,
  lifecycleSchema,
  listSessionsSchema,
  updatePolicySchema,
  updateRuleSchema,
} from './selfstudy.schemas';
import * as service from './selfstudy.service';

export async function generateHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = generateSchema.parse(req.body);

  const outcome = await service.generateForClassSession(
    auth,
    input.classSessionId,
    input.dryRun,
  );

  if (!input.dryRun) {
    await recordAudit(req, {
      action: AuditAction.AI_TASK_PUBLISHED,
      entityType: 'ClassSession',
      entityId: input.classSessionId,
      summary: `Scheduled ${outcome.planned} self-study session(s); ${outcome.skipped} skipped`,
      after: { planned: outcome.planned, skipped: outcome.skipped },
    });
  }

  return created(res, outcome);
}

export async function listHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = listSessionsSchema.parse(req.query);
  const sessions = await service.listSessions(auth, query);
  return ok(res, { sessions });
}

export async function todayHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const requested = typeof req.query.studentId === 'string' ? req.query.studentId : null;

  const studentId = auth.role === Role.STUDENT ? auth.profileId : requested;
  if (!studentId) {
    throw unprocessable('Pass a studentId, or call this as a student.');
  }

  const today = await service.todayForStudent(auth, studentId);
  return ok(res, today);
}

export async function startHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const session = await service.startSession(auth, req.params.sessionId ?? '');
  return ok(res, { session });
}

export async function heartbeatHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = lifecycleSchema.parse(req.body);
  const session = await service.recordHeartbeat(
    auth,
    req.params.sessionId ?? '',
    input.activeMinutes ?? 0,
  );
  return ok(res, { session });
}

export async function completeHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = lifecycleSchema.parse(req.body);
  const session = await service.completeSession(
    auth,
    req.params.sessionId ?? '',
    input.activeMinutes,
  );
  return ok(res, { session });
}

export async function skipHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = lifecycleSchema.parse(req.body);

  if (!input.skipReason) throw unprocessable('Give a reason for skipping.');

  const session = await service.skipSession(auth, req.params.sessionId ?? '', input.skipReason);
  return ok(res, { session });
}

export async function getPolicyHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const policy = await service.getPolicy(auth);
  return ok(res, { policy });
}

export async function updatePolicyHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = updatePolicySchema.parse(req.body);
  const { before, after } = await service.updatePolicy(auth, input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'SelfStudyPolicy',
    entityId: after.id,
    summary: 'Updated the self-study policy',
    before,
    after,
  });

  return ok(res, { policy: after });
}

export async function createRuleHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = createRuleSchema.parse(req.body);
  const rule = await service.createRule(auth, input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'SelfStudyRule',
    entityId: rule.id,
    summary: `Added the self-study rule "${rule.label}"`,
    after: rule,
  });

  return created(res, { rule });
}

export async function updateRuleHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = updateRuleSchema.parse(req.body);
  const { before, after } = await service.updateRule(auth, req.params.ruleId ?? '', input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'SelfStudyRule',
    entityId: after.id,
    summary: `Updated the self-study rule "${after.label}"`,
    before,
    after,
  });

  return ok(res, { rule: after });
}

export async function deleteRuleHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const rule = await service.deleteRule(auth, req.params.ruleId ?? '');

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'SelfStudyRule',
    entityId: rule.id,
    summary: `Deactivated the self-study rule "${rule.label}"`,
    before: rule,
  });

  return noContent(res);
}
