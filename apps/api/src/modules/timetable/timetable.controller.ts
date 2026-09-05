import { AuditAction } from '@prisma/client';
import type { Request, Response } from 'express';
import { created, noContent, ok } from '../../lib/api-response';
import { recordAudit } from '../../lib/audit';
import { nowInZone } from '../../lib/time';
import { requireContext } from '../../middleware/authorize';
import {
  createSlotSchema,
  generateSessionsSchema,
  listSessionsSchema,
  listSlotsSchema,
  updateSessionSchema,
  updateSlotSchema,
} from './timetable.schemas';
import * as service from './timetable.service';

export async function listSlotsHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = listSlotsSchema.parse(req.query);
  const slots = await service.listSlots(auth, query);
  return ok(res, { slots });
}

export async function createSlotHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = createSlotSchema.parse(req.body);
  const slot = await service.createSlot(auth, input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'TimetableSlot',
    entityId: slot.id,
    summary: `Added a ${slot.weekday} slot at ${slot.startTimeMin} minutes`,
    after: slot,
  });

  return created(res, { slot });
}

export async function updateSlotHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = updateSlotSchema.parse(req.body);
  const { before, after } = await service.updateSlot(auth, req.params.slotId ?? '', input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'TimetableSlot',
    entityId: after.id,
    summary: 'Updated a timetable slot',
    before,
    after,
  });

  return ok(res, { slot: after });
}

export async function deleteSlotHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const slot = await service.deleteSlot(auth, req.params.slotId ?? '');

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'TimetableSlot',
    entityId: slot.id,
    summary: 'Deactivated a timetable slot',
    before: slot,
  });

  return noContent(res);
}

export async function generateSessionsHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = generateSessionsSchema.parse(req.body);
  const report = await service.generateSessions(auth, input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'ClassSession',
    summary: `Generated ${report.created} class session(s) for ${input.from} to ${input.to}`,
    after: report,
  });

  return created(res, report);
}

export async function listSessionsHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = listSessionsSchema.parse(req.query);
  const sessions = await service.listSessions(auth, query);
  return ok(res, { sessions });
}

export async function upcomingHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const { date } = nowInZone(process.env.TZ ?? 'Asia/Kolkata');
  const sessions = await service.upcomingForCaller(auth, date);
  return ok(res, { from: date, sessions });
}

export async function updateSessionHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = updateSessionSchema.parse(req.body);
  const { before, after } = await service.updateSession(auth, req.params.sessionId ?? '', input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'ClassSession',
    entityId: after.id,
    summary: `Class session status ${before.status} -> ${after.status}`,
    before,
    after,
  });

  return ok(res, { session: after });
}
