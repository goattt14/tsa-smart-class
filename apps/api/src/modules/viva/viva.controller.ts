import { Role } from '@prisma/client';
import type { Request, Response } from 'express';
import { created, ok } from '../../lib/api-response';
import { unprocessable } from '../../lib/http-error';
import { requireContext } from '../../middleware/authorize';
import { CONSENT_VERSION, PROCTORING_DISCLAIMER } from '../proctoring/proctoring.signals';
import { consentSchema, listVivaSchema, scheduleVivaSchema, submitAnswerSchema } from './viva.schemas';
import * as service from './viva.service';

export async function scheduleHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = scheduleVivaSchema.parse(req.body);

  const studentId = auth.role === Role.STUDENT ? auth.profileId : input.studentId;
  if (!studentId) throw unprocessable('Pass a studentId, or call this as a student.');

  const session = await service.scheduleViva(auth, { ...input, studentId });

  return created(res, {
    session,
    // The terms travel with the session, so the client cannot show a consent
    // dialogue that says something different from what is recorded.
    consent:
      session.status === 'CONSENT_PENDING'
        ? {
            version: CONSENT_VERSION,
            required: true,
            disclaimer: PROCTORING_DISCLAIMER,
            explains: [
              'Your camera will be sampled during this viva to record observations such as whether a face is visible.',
              'No video is stored. Only the observations and their timings are kept.',
              'You can decline. The viva will still run, without monitoring.',
              'A teacher reviews anything flagged. Nothing is decided automatically.',
            ],
          }
        : { required: false },
  });
}

export async function consentHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = consentSchema.parse(req.body);
  const session = await service.recordConsent(auth, req.params.sessionId ?? '', input);
  return ok(res, { session });
}

export async function nextHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const turn = await service.nextTurn(auth, req.params.sessionId ?? '');
  return ok(res, turn);
}

export async function answerHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = submitAnswerSchema.parse(req.body);
  const result = await service.submitAnswer(auth, req.params.questionId ?? '', input);
  return ok(res, result);
}

export async function finishHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const session = await service.finishViva(auth, req.params.sessionId ?? '');
  return ok(res, { session });
}

export async function listHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = listVivaSchema.parse(req.query);
  const studentId = auth.role === Role.STUDENT ? (auth.profileId ?? undefined) : query.studentId;
  const sessions = await service.listVivas(auth, { ...query, studentId });
  return ok(res, { sessions });
}

export async function transcriptHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const transcript = await service.vivaTranscript(auth, req.params.sessionId ?? '');
  return ok(res, transcript);
}
