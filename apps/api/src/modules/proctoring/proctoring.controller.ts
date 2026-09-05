import { ProctoringContext } from '@prisma/client';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { created, ok } from '../../lib/api-response';
import { recordAudit } from '../../lib/audit';
import { requireContext } from '../../middleware/authorize';
import { AuditAction } from '@prisma/client';
import { ingestEventsSchema, reviewEventSchema } from '../viva/viva.schemas';
import * as service from './proctoring.service';

export async function ingestHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = ingestEventsSchema.parse(req.body);

  const report = await service.ingestEvents(
    auth,
    input.context,
    input.sessionId,
    input.events,
  );

  return created(res, report);
}

export async function reviewSessionHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const context = z.nativeEnum(ProctoringContext).parse(req.params.context);
  const review = await service.reviewSession(auth, context, req.params.sessionId ?? '');
  return ok(res, review);
}

export async function reviewEventHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = reviewEventSchema.parse(req.body);
  const record = await service.reviewEvent(auth, req.params.eventId ?? '', input);

  await recordAudit(req, {
    action: AuditAction.PROCTORING_REVIEWED,
    entityType: 'ProctoringEvent',
    entityId: record.id,
    summary: `Marked as ${input.status}${input.note ? `: ${input.note}` : ''}`,
    after: record,
  });

  return ok(res, { event: record });
}

export async function queueHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const queue = await service.pendingReview(auth);
  return ok(res, queue);
}

export async function overviewHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const days = Number(req.query.days ?? 30);
  const overview = await service.proctoringOverview(auth, Number.isFinite(days) ? days : 30);
  return ok(res, overview);
}
