import {
  DeliveryStatus,
  NotificationCategory,
  NotificationChannel,
  Prisma,
  Role,
} from '@prisma/client';
import webpush from 'web-push';
import { env } from '../../config/env';
import { forbidden, notFound } from '../../lib/http-error';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { nowInZone } from '../../lib/time';
import type { AuthContext } from '../../types/express';
import {
  buildDigest,
  decideDispatch,
  DEFAULT_PREFERENCES,
  type Category,
  type Channel,
  type Preferences,
} from './dispatch.rules';

const TZ = process.env.TZ ?? 'Asia/Kolkata';

let pushConfigured = false;

function configurePush(): boolean {
  if (pushConfigured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;

  webpush.setVapidDetails(
    env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
  );
  pushConfigured = true;
  return true;
}

async function loadPreferences(userId: string): Promise<Preferences> {
  const stored = await prisma.notificationPreference.findUnique({
    where: { userId },
    select: {
      inAppEnabled: true,
      pushEnabled: true,
      emailEnabled: true,
      smsEnabled: true,
      classReminders: true,
      studyReminders: true,
      resultAlerts: true,
      feeAlerts: true,
      quietHoursStartMin: true,
      quietHoursEndMin: true,
    },
  });

  return stored ?? DEFAULT_PREFERENCES;
}

export interface SendInput {
  userId: string;
  category: NotificationCategory;
  title: string;
  body: string;
  actionUrl?: string | undefined;
  data?: Record<string, unknown> | undefined;
  channels?: NotificationChannel[] | undefined;
  /** Overrides the natural dedupe key when a caller knows better. */
  dedupeKey?: string | undefined;
}

export interface SendResult {
  sent: boolean;
  notificationIds: string[];
  reason: string;
  deferredToMin: number | null;
}

/**
 * Sends one notification, subject to the dispatch rules.
 *
 * Every send goes through decideDispatch rather than writing rows directly, so
 * quiet hours, the study blackout and deduplication apply uniformly. A feature
 * that bypassed this would be the one that trains a student to switch
 * notifications off entirely.
 */
export async function send(input: SendInput): Promise<SendResult> {
  const preferences = await loadPreferences(input.userId);
  const { minutes } = nowInZone(TZ);

  const policy = await prisma.selfStudyPolicy.findFirst({
    where: { isActive: true, institute: { users: { some: { id: input.userId } } } },
    select: { newSessionCutoffMin: true, blackoutEndMin: true },
  });

  const dedupeKey = input.dedupeKey ?? `${input.category}:${input.title}`;

  const previous = await prisma.notification.findFirst({
    where: {
      userId: input.userId,
      category: input.category,
      title: input.title,
      status: { in: [DeliveryStatus.SENT, DeliveryStatus.DELIVERED, DeliveryStatus.QUEUED] },
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  const minutesSince = previous
    ? Math.floor((Date.now() - previous.createdAt.getTime()) / 60_000)
    : null;

  const decision = decideDispatch({
    category: input.category as Category,
    requested: (input.channels ?? [NotificationChannel.IN_APP, NotificationChannel.PUSH]) as Channel[],
    nowMin: minutes,
    preferences,
    minutesSinceIdentical: minutesSince,
    blackout: policy
      ? { startMin: policy.newSessionCutoffMin, endMin: policy.blackoutEndMin }
      : undefined,
  });

  if (!decision.send) {
    // Suppression is recorded rather than silent, so "why did this not arrive"
    // has an answer in the database.
    await prisma.notification.create({
      data: {
        userId: input.userId,
        category: input.category,
        channel: NotificationChannel.IN_APP,
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl ?? null,
        data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
        status: DeliveryStatus.SUPPRESSED,
        failReason: decision.reason,
      },
    });

    return { sent: false, notificationIds: [], reason: decision.reason, deferredToMin: null };
  }

  const scheduledAt =
    decision.deferToMin !== null ? minutesToNextOccurrence(decision.deferToMin) : null;

  const ids: string[] = [];

  for (const channel of decision.channels) {
    const record = await prisma.notification.create({
      data: {
        userId: input.userId,
        category: input.category,
        channel: channel as NotificationChannel,
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl ?? null,
        data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
        scheduledAt,
        status: scheduledAt ? DeliveryStatus.QUEUED : DeliveryStatus.SENT,
        sentAt: scheduledAt ? null : new Date(),
      },
      select: { id: true },
    });

    ids.push(record.id);

    if (!scheduledAt && channel === NotificationChannel.PUSH) {
      await deliverPush(input.userId, record.id, input.title, input.body, input.actionUrl);
    }
  }

  return {
    sent: true,
    notificationIds: ids,
    reason: decision.reason,
    deferredToMin: decision.deferToMin,
  };
}

/** Turns a minute-of-day into the next real instant at that time. */
function minutesToNextOccurrence(minuteOfDay: number): Date {
  const now = new Date();
  const { minutes } = nowInZone(TZ, now);

  const deltaMin = minuteOfDay > minutes ? minuteOfDay - minutes : 1440 - minutes + minuteOfDay;

  return new Date(now.getTime() + deltaMin * 60_000);
}

async function deliverPush(
  userId: string,
  notificationId: string,
  title: string,
  body: string,
  actionUrl?: string | undefined,
): Promise<void> {
  if (!configurePush()) {
    logger.debug('push not configured; the in-app notification still stands');
    return;
  }

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify({ title, body, url: actionUrl ?? '/', notificationId }),
      );

      await prisma.pushSubscription.update({
        where: { id: subscription.id },
        data: { lastUsedAt: new Date() },
      });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;

      // 404 and 410 mean the browser threw the subscription away. Keeping it
      // would mean retrying a dead endpoint forever.
      if (status === 404 || status === 410) {
        await prisma.pushSubscription.delete({ where: { id: subscription.id } });
        continue;
      }

      logger.warn({ err: error, userId }, 'push delivery failed');
      await prisma.notification.update({
        where: { id: notificationId },
        data: { status: DeliveryStatus.FAILED, failReason: String(status ?? 'unknown') },
      });
    }
  }
}

/** Sends the same notification to many people, respecting each one's settings. */
export async function sendBulk(
  userIds: string[],
  template: Omit<SendInput, 'userId'>,
): Promise<{ sent: number; suppressed: number }> {
  let sent = 0;
  let suppressed = 0;

  for (const userId of userIds) {
    const result = await send({ ...template, userId });
    if (result.sent) sent += 1;
    else suppressed += 1;
  }

  return { sent, suppressed };
}

export async function listForUser(
  auth: AuthContext,
  args: { unreadOnly: boolean; limit: number },
) {
  const notifications = await prisma.notification.findMany({
    where: {
      userId: auth.userId,
      channel: NotificationChannel.IN_APP,
      status: { in: [DeliveryStatus.SENT, DeliveryStatus.DELIVERED] },
      ...(args.unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: args.limit,
    select: {
      id: true,
      category: true,
      title: true,
      body: true,
      actionUrl: true,
      data: true,
      readAt: true,
      createdAt: true,
    },
  });

  const unreadCount = await prisma.notification.count({
    where: {
      userId: auth.userId,
      channel: NotificationChannel.IN_APP,
      readAt: null,
      status: { in: [DeliveryStatus.SENT, DeliveryStatus.DELIVERED] },
    },
  });

  const digest = buildDigest(
    notifications
      .filter((n) => n.readAt === null)
      .map((n) => ({
        category: n.category as Category,
        title: n.title,
        createdAtMin: Math.floor(n.createdAt.getTime() / 60_000),
      })),
  );

  return {
    notifications,
    unreadCount,
    digestHeadline: digest.shouldSend ? digest.headline : null,
  };
}

export async function markRead(auth: AuthContext, ids: string[]) {
  const result = await prisma.notification.updateMany({
    where: { id: { in: ids }, userId: auth.userId, readAt: null },
    data: { readAt: new Date() },
  });

  return { marked: result.count };
}

export async function markAllRead(auth: AuthContext) {
  const result = await prisma.notification.updateMany({
    where: { userId: auth.userId, readAt: null },
    data: { readAt: new Date() },
  });

  return { marked: result.count };
}

export async function getPreferences(auth: AuthContext) {
  const existing = await prisma.notificationPreference.findUnique({
    where: { userId: auth.userId },
  });

  if (existing) return existing;

  return prisma.notificationPreference.create({ data: { userId: auth.userId } });
}

export async function updatePreferences(auth: AuthContext, input: Record<string, unknown>) {
  return prisma.notificationPreference.upsert({
    where: { userId: auth.userId },
    update: input as Prisma.NotificationPreferenceUpdateInput,
    create: { userId: auth.userId, ...(input as object) },
  });
}

export async function subscribePush(
  auth: AuthContext,
  input: { endpoint: string; p256dh: string; auth: string; platform?: string | undefined },
) {
  return prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    update: { userId: auth.userId, p256dh: input.p256dh, auth: input.auth, lastUsedAt: new Date() },
    create: {
      userId: auth.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      platform: input.platform ?? 'web',
    },
    select: { id: true, platform: true, createdAt: true },
  });
}

export async function unsubscribePush(auth: AuthContext, endpoint: string) {
  const result = await prisma.pushSubscription.deleteMany({
    where: { endpoint, userId: auth.userId },
  });

  if (result.count === 0) throw notFound('Push subscription');
  return { removed: result.count };
}

/** Delivers anything queued whose scheduled time has arrived. Run every minute. */
export async function flushScheduled(): Promise<number> {
  const due = await prisma.notification.findMany({
    where: { status: DeliveryStatus.QUEUED, scheduledAt: { lte: new Date() } },
    take: 200,
    select: { id: true, userId: true, channel: true, title: true, body: true, actionUrl: true },
  });

  for (const notification of due) {
    await prisma.notification.update({
      where: { id: notification.id },
      data: { status: DeliveryStatus.SENT, sentAt: new Date() },
    });

    if (notification.channel === NotificationChannel.PUSH) {
      await deliverPush(
        notification.userId,
        notification.id,
        notification.title,
        notification.body,
        notification.actionUrl ?? undefined,
      );
    }
  }

  return due.length;
}

// ---------------------------------------------------------- announcements ---

export interface AudienceSpec {
  roles?: Role[] | undefined;
  batchIds?: string[] | undefined;
}

export async function createAnnouncement(
  auth: AuthContext,
  input: {
    title: string;
    body: string;
    audience: AudienceSpec;
    isPinned: boolean;
    publishAt?: Date | undefined;
    expiresAt?: Date | undefined;
    notify: boolean;
  },
) {
  const announcement = await prisma.announcement.create({
    data: {
      instituteId: auth.instituteId,
      createdById: auth.userId,
      title: input.title,
      body: input.body,
      audience: input.audience as unknown as Prisma.InputJsonValue,
      isPinned: input.isPinned,
      publishAt: input.publishAt ?? new Date(),
      expiresAt: input.expiresAt ?? null,
    },
    select: { id: true, title: true, publishAt: true },
  });

  if (input.notify) {
    const recipients = await resolveAudience(auth.instituteId, input.audience);

    await sendBulk(recipients, {
      category: NotificationCategory.ANNOUNCEMENT,
      title: input.title,
      body: input.body.slice(0, 200),
      actionUrl: `/announcements/${announcement.id}`,
      dedupeKey: `announcement:${announcement.id}`,
    });
  }

  return announcement;
}

async function resolveAudience(instituteId: string, audience: AudienceSpec): Promise<string[]> {
  const where: Prisma.UserWhereInput = {
    instituteId,
    deletedAt: null,
    status: 'ACTIVE',
    ...(audience.roles && audience.roles.length > 0 ? { role: { in: audience.roles } } : {}),
  };

  if (audience.batchIds && audience.batchIds.length > 0) {
    // Batch targeting reaches the students enrolled and the parents linked to
    // them, which is what an admin means by "tell class 10".
    where.OR = [
      { studentProfile: { enrollments: { some: { batchId: { in: audience.batchIds }, status: 'ACTIVE' } } } },
      {
        parentProfile: {
          children: {
            some: {
              student: {
                enrollments: { some: { batchId: { in: audience.batchIds }, status: 'ACTIVE' } },
              },
            },
          },
        },
      },
    ];
  }

  const users = await prisma.user.findMany({ where, select: { id: true } });
  return users.map((user) => user.id);
}

export async function listAnnouncements(auth: AuthContext, limit = 30) {
  const now = new Date();

  const announcements = await prisma.announcement.findMany({
    where: {
      instituteId: auth.instituteId,
      publishAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ isPinned: 'desc' }, { publishAt: 'desc' }],
    take: limit,
    select: {
      id: true,
      title: true,
      body: true,
      audience: true,
      isPinned: true,
      publishAt: true,
      expiresAt: true,
      createdBy: { select: { firstName: true, lastName: true, role: true } },
    },
  });

  // Filtering by audience after the query keeps the JSON shape flexible without
  // pushing role logic into SQL.
  return announcements.filter((announcement) => {
    const audience = (announcement.audience ?? {}) as AudienceSpec;
    if (!audience.roles || audience.roles.length === 0) return true;
    return audience.roles.includes(auth.role);
  });
}

export async function deleteAnnouncement(auth: AuthContext, announcementId: string) {
  const announcement = await prisma.announcement.findFirst({
    where: { id: announcementId, instituteId: auth.instituteId },
    select: { id: true, title: true, createdById: true },
  });

  if (!announcement) throw notFound('Announcement');

  if (auth.role === Role.TEACHER && announcement.createdById !== auth.userId) {
    throw forbidden('You can only delete announcements you posted.');
  }

  await prisma.announcement.delete({ where: { id: announcementId } });
  return announcement;
}
