import { AuditAction } from '@prisma/client';
import type { Request, Response } from 'express';
import { created, ok } from '../../lib/api-response';
import { recordAudit } from '../../lib/audit';
import { requireContext } from '../../middleware/authorize';
import {
  createTestSchema,
  gradeAnswerSchema,
  listTestsSchema,
  saveAnswerSchema,
  setQuestionsSchema,
} from './tests.schemas';
import * as service from './tests.service';

export async function listHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const tests = await service.listTests(auth, listTestsSchema.parse(req.query));
  return ok(res, { tests });
}

export async function createHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = createTestSchema.parse(req.body);
  const { test } = await service.createTest(auth, input);

  await recordAudit(req, {
    action: AuditAction.TEST_CREATED,
    entityType: 'Test',
    entityId: test.id,
    summary: `Created the test "${test.title}"`,
    after: { title: test.title, type: test.type, scheduledAt: test.scheduledAt },
  });

  return created(res, { test });
}

export async function setQuestionsHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = setQuestionsSchema.parse(req.body);
  const passingPct = Number(req.query.passingPct ?? 35);

  const report = await service.setQuestions(
    auth,
    req.params.testId ?? '',
    input.questions,
    Number.isFinite(passingPct) ? passingPct : 35,
  );

  await recordAudit(req, {
    action: AuditAction.TEST_CREATED,
    entityType: 'Test',
    entityId: req.params.testId ?? '',
    summary: `Set ${report.questionCount} question(s), total ${report.maxMarks} marks`,
    after: report,
  });

  return ok(res, report);
}

export async function publishHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const test = await service.publishTest(auth, req.params.testId ?? '');

  await recordAudit(req, {
    action: AuditAction.TEST_PUBLISHED,
    entityType: 'Test',
    entityId: test.id,
    summary: `Published "${test.title}" for ${test.scheduledAt.toISOString()}`,
  });

  return ok(res, { test });
}

export async function startAttemptHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const attempt = await service.startAttempt(auth, req.params.testId ?? '');
  return created(res, { attempt });
}

export async function paperHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const paper = await service.loadPaper(
    auth,
    req.params.testId ?? '',
    req.params.attemptId ?? '',
  );
  return ok(res, paper);
}

export async function saveAnswerHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = saveAnswerSchema.parse(req.body);
  const answer = await service.saveAnswer(auth, req.params.attemptId ?? '', input);
  return ok(res, { answer });
}

export async function submitHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const report = await service.submitAttempt(auth, req.params.attemptId ?? '');
  return ok(res, report);
}

export async function gradeHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = gradeAnswerSchema.parse(req.body);
  const attempt = await service.gradeWrittenAnswer(
    auth,
    req.params.answerId ?? '',
    input.marksAwarded,
  );

  await recordAudit(req, {
    action: AuditAction.MARKS_UPDATED,
    entityType: 'TestAnswer',
    entityId: req.params.answerId ?? '',
    summary: `Awarded ${input.marksAwarded} marks by hand`,
    after: attempt,
  });

  return ok(res, { attempt });
}

export async function publishResultsHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const report = await service.publishResults(auth, req.params.testId ?? '');

  await recordAudit(req, {
    action: AuditAction.RESULT_PUBLISHED,
    entityType: 'Test',
    entityId: req.params.testId ?? '',
    summary: `Published results for ${report.published} attempt(s)`,
    after: report,
  });

  return ok(res, report);
}

export async function resultHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const result = await service.attemptResult(auth, req.params.attemptId ?? '');
  return ok(res, result);
}
