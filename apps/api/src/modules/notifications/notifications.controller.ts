import { AuditAction, Role } from '@prisma/client';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { created, noContent, ok } from '../../lib/api-response';
import { recordAudit } from '../../lib/audit';
import { requireContext } from '../../middleware/authorize';
import * as service from './notifications.service';

const listSchema = z.object({
  unreadOnly: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const markReadSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

const preferencesSchema = z.object({
  inAppEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
  classReminders: z.boolean().optional(),
  studyReminders: z.boolean().optional(),
  resultAlerts: z.boolean().optional(),
  feeAlerts: z.boolean().optional(),
  quietHoursStartMin: z.coerce.number().int().min(0).max(1440).nullable().optional(),
  quietHoursEndMin: z.coerce.number().int().min(0).max(1440).nullable().optional(),
});

const subscribeSchema = z.object({
  endpoint: z.string().url().max(600),
  p256dh: z.string().min(10).max(300),
  auth: z.string().min(5).max(300),
  platform: z.string().trim().max(20).optional(),
});

const announcementSchema = z.object({
  title: z.string().trim().min(3).max(160),
  body: z.string().trim().min(5).max(5000),
  audience: z.object({
    roles: z.array(z.nativeEnum(Role)).max(5).optional(),
    batchIds: z.array(z.string().uuid()).max(50).optional(),
  }),
  isPinned: z.boolean().default(false),
  publishAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
  notify: z.boolean().default(true),
});

export async function listHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  return ok(res, await service.listForUser(auth, listSchema.parse(req.query)));
}

export async function markReadHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = markReadSchema.parse(req.body);
  return ok(res, await service.markRead(auth, input.ids));
}

export async function markAllReadHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  return ok(res, await service.markAllRead(auth));
}

export async function getPreferencesHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  return ok(res, { preferences: await service.getPreferences(auth) });
}

export async function updatePreferencesHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = preferencesSchema.parse(req.body);
  return ok(res, { preferences: await service.updatePreferences(auth, input) });
}

export async function subscribeHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = subscribeSchema.parse(req.body);
  return created(res, { subscription: await service.subscribePush(auth, input) });
}

export async function unsubscribeHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const endpoint = z.string().url().parse(req.body?.endpoint);
  return ok(res, await service.unsubscribePush(auth, endpoint));
}

export async function createAnnouncementHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = announcementSchema.parse(req.body);
  const announcement = await service.createAnnouncement(auth, input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'Announcement',
    entityId: announcement.id,
    summary: `Posted the announcement "${announcement.title}"`,
  });

  return created(res, { announcement });
}

export async function listAnnouncementsHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  return ok(res, { announcements: await service.listAnnouncements(auth) });
}

export async function deleteAnnouncementHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const announcement = await service.deleteAnnouncement(auth, req.params.announcementId ?? '');

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'Announcement',
    entityId: announcement.id,
    summary: `Deleted the announcement "${announcement.title}"`,
  });

  return noContent(res);
}
