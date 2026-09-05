import { Role } from '@prisma/client';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ok } from '../../lib/api-response';
import { unprocessable } from '../../lib/http-error';
import { requireContext } from '../../middleware/authorize';
import * as service from './performance.service';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form YYYY-MM-DD');

const seriesSchema = z.object({
  metricKey: z.string().trim().min(2).max(60),
  scope: z.enum(['STUDENT', 'BATCH', 'TEACHER', 'INSTITUTE']),
  scopeId: z.string().uuid().optional(),
  from: dateString,
  to: dateString,
});

function resolveStudentId(req: Request): string {
  const auth = requireContext(req);
  const requested = typeof req.query.studentId === 'string' ? req.query.studentId : null;
  const studentId = auth.role === Role.STUDENT ? auth.profileId : requested;

  if (!studentId) throw unprocessable('Pass a studentId, or call this as a student.');
  return studentId;
}

export async function overviewHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const overview = await service.studentOverview(auth, resolveStudentId(req));
  return ok(res, overview);
}

export async function refreshHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const studentId = resolveStudentId(req);

  const [recommendations, profiles] = await Promise.all([
    service.refreshRecommendations(auth, studentId),
    service.refreshLearningProfiles(auth, studentId),
  ]);

  return ok(res, { recommendations, subjectProfiles: profiles });
}

export async function ingestHandler(req: Request, res: Response) {
  requireContext(req);
  const updated = await service.ingestAttempt(req.params.attemptId ?? '');
  return ok(res, { topicsUpdated: updated });
}

export async function dismissHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const record = await service.dismissRecommendation(auth, req.params.recommendationId ?? '');
  return ok(res, { recommendation: record });
}

export async function batchHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const report = await service.batchPerformance(auth, req.params.batchId ?? '');
  return ok(res, report);
}

export async function seriesHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = seriesSchema.parse(req.query);
  const series = await service.metricSeries(auth, query);
  return ok(res, { metricKey: query.metricKey, series });
}
