import type { Request, Response } from 'express';
import { ok } from '../../lib/api-response';
import { requireContext } from '../../middleware/authorize';
import * as service from './dashboard.service';

export async function dashboardHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const studentId = typeof req.query.studentId === 'string' ? req.query.studentId : undefined;
  return ok(res, await service.dashboardFor(auth, studentId));
}

export async function studentHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const studentId = req.params.studentId ?? auth.profileId ?? '';
  return ok(res, await service.studentDashboard(auth, studentId));
}
