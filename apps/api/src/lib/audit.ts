import type { AuditAction, Prisma, Role } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from './prisma';
import { logger } from './logger';

export interface AuditInput {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  actorId?: string | null;
  actorRole?: Role | null;
}

/** Fields that must never be written into an audit row. */
const REDACTED = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'tokenHash',
  'token',
  'refreshToken',
  'accessToken',
  'secret',
]);

function scrub(value: unknown, depth = 0): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (depth > 4) return '[truncated]';

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => scrub(item, depth + 1) ?? null);
  }

  if (typeof value === 'object') {
    const out: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED.has(key) ? '[redacted]' : (scrub(raw, depth + 1) ?? null);
    }
    return out;
  }

  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value as Prisma.InputJsonValue;
}

/**
 * Audit writes must never break the request that triggered them. A failure to
 * record history is logged loudly and swallowed; a failure to mark attendance
 * because the audit table was busy would be worse.
 */
export async function recordAudit(req: Request, input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? req.auth?.userId ?? null,
        actorRole: input.actorRole ?? req.auth?.role ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        summary: input.summary.slice(0, 500),
        beforeData: scrub(input.before),
        afterData: scrub(input.after),
        ipAddress: req.ip ?? null,
        userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
        requestId: req.requestId ?? null,
      },
    });
  } catch (error) {
    logger.error({ err: error, action: input.action }, 'failed to write audit log');
  }
}
