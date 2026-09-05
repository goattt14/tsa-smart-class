import type { Role } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { PERMISSIONS, ROLE_MATRIX } from './permissions.catalog';

interface CacheEntry {
  permissions: Set<string>;
  expiresAt: number;
}

/**
 * Permission lookups happen on nearly every request, so they are cached for a
 * short window. The TTL is deliberately small and every mutation calls
 * invalidateUserPermissions, so a revoke takes effect immediately rather than
 * waiting for expiry.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export function invalidateUserPermissions(userId: string): void {
  cache.delete(userId);
}

export function invalidateAllPermissions(): void {
  cache.clear();
}

/**
 * Effective permissions = role defaults, plus GRANT overrides, minus REVOKE
 * overrides. Expired overrides are ignored. Revoke wins over grant, which is
 * the safe direction for a conflict.
 */
export async function resolvePermissions(userId: string, role: Role): Promise<Set<string>> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.permissions;

  const effective = new Set<string>(ROLE_MATRIX[role] ?? []);

  const overrides = await prisma.userPermission.findMany({
    where: {
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { effect: true, permission: { select: { key: true } } },
  });

  for (const override of overrides) {
    if (override.effect === 'GRANT') effective.add(override.permission.key);
  }
  for (const override of overrides) {
    if (override.effect === 'REVOKE') effective.delete(override.permission.key);
  }

  cache.set(userId, { permissions: effective, expiresAt: Date.now() + CACHE_TTL_MS });
  return effective;
}

/**
 * Writes the catalogue into the database and reconciles the role matrix.
 * Idempotent: safe to run on every boot and from the seed script.
 */
export async function syncPermissionCatalog(): Promise<{ permissions: number; roleLinks: number }> {
  for (const definition of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: definition.key },
      update: {
        resource: definition.resource,
        action: definition.action,
        description: definition.description,
        isSensitive: definition.isSensitive,
      },
      create: definition,
    });
  }

  const rows = await prisma.permission.findMany({ select: { id: true, key: true } });
  const idByKey = new Map(rows.map((row) => [row.key, row.id]));

  let roleLinks = 0;

  for (const [role, keys] of Object.entries(ROLE_MATRIX)) {
    const desired = new Set(keys);
    const typedRole = role as Role;

    const existing = await prisma.rolePermission.findMany({
      where: { role: typedRole },
      select: { id: true, permission: { select: { key: true } } },
    });
    const existingKeys = new Set(existing.map((row) => row.permission.key));

    for (const key of desired) {
      if (existingKeys.has(key)) continue;
      const permissionId = idByKey.get(key);
      if (!permissionId) {
        logger.warn({ key, role }, 'role matrix references an unknown permission key');
        continue;
      }
      await prisma.rolePermission.create({ data: { role: typedRole, permissionId } });
      roleLinks += 1;
    }

    // Remove links the matrix no longer declares, so the database cannot drift
    // ahead of the code that is meant to define it.
    const stale = existing.filter((row) => !desired.has(row.permission.key));
    if (stale.length > 0) {
      await prisma.rolePermission.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
    }
  }

  invalidateAllPermissions();
  return { permissions: PERMISSIONS.length, roleLinks };
}
