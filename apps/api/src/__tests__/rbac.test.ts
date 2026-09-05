import { Role } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { requirePermission, requireRole } from '../middleware/authorize';
import { PERMISSIONS, ROLE_MATRIX, SENSITIVE_KEYS } from '../modules/auth/permissions.catalog';
import type { AuthContext } from '../types/express';

function context(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'u-1',
    instituteId: 'i-1',
    role: Role.TEACHER,
    email: 'teacher@tsa.edu.in',
    sessionId: 's-1',
    permissions: new Set(ROLE_MATRIX[Role.TEACHER]),
    profileId: 'p-1',
    aggregateOnly: false,
    ...overrides,
  };
}

function run(handler: ReturnType<typeof requirePermission>, auth?: AuthContext) {
  const req = { auth } as unknown as Request;
  const res = {} as Response;
  let error: unknown = null;
  const next: NextFunction = (err?: unknown) => {
    error = err ?? null;
  };
  handler(req, res, next);
  return error as { statusCode?: number; message?: string } | null;
}

describe('permission catalogue integrity', () => {
  it('has no duplicate keys', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('only references keys that exist in the catalogue', () => {
    const known = new Set(PERMISSIONS.map((p) => p.key));
    for (const [role, keys] of Object.entries(ROLE_MATRIX)) {
      for (const key of keys) {
        expect(known.has(key), `${role} references unknown permission ${key}`).toBe(true);
      }
    }
  });

  it('gives the administrator every permission', () => {
    expect(ROLE_MATRIX[Role.ADMIN]).toHaveLength(PERMISSIONS.length);
  });

  it('grants management no sensitive permission by default', () => {
    const sensitive = ROLE_MATRIX[Role.MANAGEMENT].filter((key) => SENSITIVE_KEYS.has(key));
    expect(sensitive).toEqual([]);
  });

  it('does not let a student read another student results', () => {
    expect(ROLE_MATRIX[Role.STUDENT]).not.toContain('results.read.any');
    expect(ROLE_MATRIX[Role.STUDENT]).not.toContain('performance.read.any');
  });

  it('does not let a parent mark attendance or grade work', () => {
    expect(ROLE_MATRIX[Role.PARENT]).not.toContain('attendance.mark');
    expect(ROLE_MATRIX[Role.PARENT]).not.toContain('homework.grade');
  });
});

describe('requirePermission', () => {
  it('allows a teacher to mark attendance', () => {
    expect(run(requirePermission('attendance.mark'), context())).toBeNull();
  });

  it('refuses a permission the role does not hold', () => {
    const error = run(requirePermission('fees.manage'), context());
    expect(error?.statusCode).toBe(403);
  });

  it('refuses an anonymous caller', () => {
    const error = run(requirePermission('classes.read'), undefined);
    expect(error?.statusCode).toBe(401);
  });

  it('blocks a sensitive key for an aggregate-only account even when granted', () => {
    const auth = context({
      role: Role.MANAGEMENT,
      aggregateOnly: true,
      // Simulates an override that handed over a sensitive key.
      permissions: new Set([...ROLE_MATRIX[Role.MANAGEMENT], 'results.read.any']),
    });

    const error = run(requirePermission('results.read.any'), auth);
    expect(error?.statusCode).toBe(403);
    expect(error?.message).toContain('aggregate');
  });

  it('allows the same key once aggregate-only is lifted', () => {
    const auth = context({
      role: Role.MANAGEMENT,
      aggregateOnly: false,
      permissions: new Set([...ROLE_MATRIX[Role.MANAGEMENT], 'results.read.any']),
    });

    expect(run(requirePermission('results.read.any'), auth)).toBeNull();
  });
});

describe('requireRole', () => {
  it('allows a listed role', () => {
    expect(run(requireRole(Role.TEACHER, Role.ADMIN), context())).toBeNull();
  });

  it('refuses an unlisted role', () => {
    const error = run(requireRole(Role.ADMIN), context());
    expect(error?.statusCode).toBe(403);
  });
});
