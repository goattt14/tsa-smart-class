import { AuditAction, Role } from '@prisma/client';
import type { Request, Response } from 'express';
import { created, ok } from '../../lib/api-response';
import { recordAudit } from '../../lib/audit';
import { unprocessable } from '../../lib/http-error';
import { requireContext } from '../../middleware/authorize';
import { usageSummary } from '../../ai/router';
import * as evaluation from './evaluation.service';
import * as rag from './rag.service';
import * as taskgen from './taskgen.service';
import {
  approveTaskSchema,
  evaluateSchema,
  generateTaskSchema,
  listTasksSchema,
  overrideSchema,
  rejectTaskSchema,
  retrieveSchema,
} from './ai.schemas';

export async function generateHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = generateTaskSchema.parse(req.body);
  const result = await taskgen.generateTask(auth, input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'AiTask',
    entityId: result.task.id,
    summary: `Generated ${result.generated} question(s) from ${result.grounding.passagesUsed} source passage(s) via ${result.provider}`,
    after: { generated: result.generated, rejected: result.rejected.length },
  });

  return created(res, result);
}

export async function listTasksHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const tasks = await taskgen.listTasks(auth, listTasksSchema.parse(req.query));
  return ok(res, { tasks });
}

export async function reviewHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const task = await taskgen.taskForReview(auth, req.params.taskId ?? '');
  return ok(res, { task });
}

export async function approveHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = approveTaskSchema.parse(req.body);
  const result = await taskgen.approveTask(auth, req.params.taskId ?? '', input.approvedQuestionIds);

  await recordAudit(req, {
    action: AuditAction.AI_TASK_PUBLISHED,
    entityType: 'AiTask',
    entityId: result.taskId,
    summary: `Approved ${result.approved} question(s), discarded ${result.discarded}`,
    after: result,
  });

  return ok(res, result);
}

export async function rejectHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = rejectTaskSchema.parse(req.body);
  const result = await taskgen.rejectTask(auth, req.params.taskId ?? '', input.reason);

  await recordAudit(req, {
    action: AuditAction.AI_TASK_PUBLISHED,
    entityType: 'AiTask',
    entityId: result.taskId,
    summary: `Rejected the whole generated set: ${input.reason}`,
  });

  return ok(res, result);
}

export async function evaluateHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = evaluateSchema.parse(req.body);

  const result = await evaluation.evaluateAnswer(auth, {
    kind: input.target,
    id: input.id,
  } as evaluation.EvaluationTarget);

  return ok(res, { evaluation: result });
}

export async function overrideHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = overrideSchema.parse(req.body);
  const record = await evaluation.overrideEvaluation(
    auth,
    req.params.evaluationId ?? '',
    input,
  );

  await recordAudit(req, {
    action: AuditAction.AI_EVALUATION_OVERRIDDEN,
    entityType: 'AiEvaluation',
    entityId: record.id,
    summary: `Overrode the AI mark to ${input.score}: ${input.reason}`,
    after: record,
  });

  return ok(res, { evaluation: record });
}

export async function reliabilityHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const report = await evaluation.evaluationReliability(auth.instituteId);
  return ok(res, report);
}

export async function ingestHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const result = await rag.ingestMaterial(req.params.materialId ?? '');

  await recordAudit(req, {
    action: AuditAction.MATERIAL_UPLOADED,
    entityType: 'StudyMaterial',
    entityId: result.materialId,
    summary: `Indexed for retrieval: ${result.chunks} chunk(s), ${result.embedded} embedded`,
    after: result,
    actorId: auth.userId,
  });

  return ok(res, result);
}

export async function reindexHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const result = await rag.reindexPending(auth.instituteId);
  return ok(res, result);
}

export async function indexStatusHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const status = await rag.indexStatus(auth.instituteId);
  return ok(res, status);
}

export async function retrieveHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = retrieveSchema.parse(req.body);

  const result = await rag.retrievePassages(
    input.query,
    { subjectId: input.subjectId, topicId: input.topicId, batchId: input.batchId },
    auth.instituteId,
  );

  return ok(res, {
    degraded: result.degraded,
    passages: result.chunks.map((chunk) => ({
      id: chunk.id,
      score: chunk.score,
      materialTitle: chunk.materialTitle,
      sectionTitle: chunk.sectionTitle,
      pageNumber: chunk.pageNumber,
      excerpt: chunk.content.slice(0, 400),
    })),
  });
}

export async function usageHandler(req: Request, res: Response) {
  const auth = requireContext(req);

  if (auth.role !== Role.ADMIN && auth.role !== Role.MANAGEMENT) {
    throw unprocessable('AI usage is visible to administrators and management.');
  }

  return ok(res, await usageSummary());
}
