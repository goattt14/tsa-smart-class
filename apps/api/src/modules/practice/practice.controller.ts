import { Role } from '@prisma/client';
import type { Request, Response } from 'express';
import { created, ok } from '../../lib/api-response';
import { unprocessable } from '../../lib/http-error';
import { requireContext } from '../../middleware/authorize';
import {
  buildPracticeSchema,
  listPracticeSchema,
  practiceAnswerSchema,
} from '../ai/ai.schemas';
import * as service from './practice.service';

export async function buildHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = buildPracticeSchema.parse(req.body);

  const studentId = auth.role === Role.STUDENT ? auth.profileId : input.studentId;
  if (!studentId) throw unprocessable('Pass a studentId, or call this as a student.');

  const result = await service.buildPracticeSession(auth, { ...input, studentId });
  return created(res, result);
}

export async function listHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = listPracticeSchema.parse(req.query);

  const studentId =
    auth.role === Role.STUDENT ? (auth.profileId ?? undefined) : query.studentId;

  const sessions = await service.listPractice(auth, { ...query, studentId });
  return ok(res, { sessions });
}

export async function loadHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const result = await service.loadPractice(auth, req.params.sessionId ?? '');
  return ok(res, result);
}

export async function startHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const session = await service.startPractice(auth, req.params.sessionId ?? '');
  return ok(res, { session });
}

export async function answerHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = practiceAnswerSchema.parse(req.body);
  const answer = await service.savePracticeAnswer(
    auth,
    req.params.practiceQuestionId ?? '',
    input,
  );
  return ok(res, { answer });
}

export async function submitHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const report = await service.submitPractice(auth, req.params.sessionId ?? '');
  return ok(res, report);
}
