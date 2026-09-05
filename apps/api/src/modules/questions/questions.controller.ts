import { AuditAction } from '@prisma/client';
import type { Request, Response } from 'express';
import { created, noContent, ok, paginated } from '../../lib/api-response';
import { recordAudit } from '../../lib/audit';
import { requireContext } from '../../middleware/authorize';
import {
  bulkImportSchema,
  listQuestionsSchema,
  questionBodySchema,
  updateQuestionSchema,
} from './questions.schemas';
import * as service from './questions.service';

export async function listHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = listQuestionsSchema.parse(req.query);
  const result = await service.listQuestions(auth, query);
  return paginated(res, result.items, result.meta);
}

export async function createHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = questionBodySchema.parse(req.body);
  const question = await service.createQuestion(auth, input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'Question',
    entityId: question.id,
    summary: `Added a ${question.type} question worth ${question.marks} marks`,
  });

  return created(res, { question });
}

export async function bulkImportHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = bulkImportSchema.parse(req.body);
  const report = await service.bulkImport(auth, input.questions);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'Question',
    summary: `Imported ${report.created} question(s), ${report.failed.length} rejected`,
    after: { created: report.created, failed: report.failed.length },
  });

  return created(res, report);
}

export async function updateHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = updateQuestionSchema.parse(req.body);
  const { after } = await service.updateQuestion(auth, req.params.questionId ?? '', input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'Question',
    entityId: after.id,
    summary: 'Updated a question',
  });

  return ok(res, { question: after });
}

export async function deleteHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const question = await service.deleteQuestion(auth, req.params.questionId ?? '');

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'Question',
    entityId: question.id,
    summary: 'Deleted a question',
    before: question,
  });

  return noContent(res);
}
