import { AuditAction, Role } from '@prisma/client';
import type { Request, Response } from 'express';
import { created, ok, paginated } from '../../lib/api-response';
import { recordAudit } from '../../lib/audit';
import { requireContext } from '../../middleware/authorize';
import { PERMISSIONS } from '../auth/permissions.catalog';
import {
  createUserSchema,
  linkChildSchema,
  listUsersSchema,
  overridePermissionSchema,
  setStatusSchema,
  updateUserSchema,
} from './users.schemas';
import * as usersService from './users.service';

export async function listUsersHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = listUsersSchema.parse(req.query);
  const result = await usersService.listUsers(auth, query);
  return paginated(res, result.items, result.meta);
}

export async function getUserHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const targetId = req.params.userId === 'me' ? auth.userId : (req.params.userId ?? '');
  const user = await usersService.getUserDetail(auth, targetId);
  return ok(res, { user });
}

export async function createUserHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = createUserSchema.parse(req.body);

  // Only an administrator may mint another administrator.
  if (input.role === Role.ADMIN && auth.role !== Role.ADMIN) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Only an administrator can create another administrator account.',
      },
    });
  }

  const result = await usersService.createUser(auth, input);

  await recordAudit(req, {
    action: AuditAction.USER_CREATED,
    entityType: 'User',
    entityId: result.userId,
    summary: `Created ${input.role} account for ${input.email}`,
    after: { email: input.email, role: input.role, name: `${input.firstName} ${input.lastName}` },
  });

  return created(res, {
    userId: result.userId,
    // Shown once. It is never retrievable again; an admin can only reset it.
    temporaryPassword: result.temporaryPassword,
  });
}

export async function updateUserHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const targetId = req.params.userId === 'me' ? auth.userId : (req.params.userId ?? '');
  const input = updateUserSchema.parse(req.body);

  const { before, after } = await usersService.updateUser(auth, targetId, input);

  await recordAudit(req, {
    action: AuditAction.USER_UPDATED,
    entityType: 'User',
    entityId: targetId,
    summary: `Updated account ${after.email}`,
    before,
    after,
  });

  return ok(res, { user: after });
}

export async function setStatusHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const targetId = req.params.userId ?? '';
  const input = setStatusSchema.parse(req.body);

  const { before, after } = await usersService.setUserStatus(auth, targetId, input.status);

  await recordAudit(req, {
    action: AuditAction.USER_DISABLED,
    entityType: 'User',
    entityId: targetId,
    summary: `Status changed from ${before.status} to ${input.status}${
      input.reason ? `: ${input.reason}` : ''
    }`,
    before,
    after,
  });

  return ok(res, { user: after });
}

export async function deleteUserHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const targetId = req.params.userId ?? '';
  const user = await usersService.softDeleteUser(auth, targetId);

  await recordAudit(req, {
    action: AuditAction.USER_DELETED,
    entityType: 'User',
    entityId: targetId,
    summary: `Soft-deleted ${user.role} account ${user.email}`,
    before: user,
  });

  return ok(res, { deleted: true });
}

export async function resetPasswordHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const targetId = req.params.userId ?? '';
  const result = await usersService.resetUserPassword(auth, targetId);

  await recordAudit(req, {
    action: AuditAction.USER_UPDATED,
    entityType: 'User',
    entityId: targetId,
    summary: `Administrator reset the password for ${result.email}`,
  });

  return ok(res, {
    email: result.email,
    temporaryPassword: result.temporaryPassword,
    message: 'Share this once. The user must change it at next sign-in.',
  });
}

export async function permissionCatalogHandler(_req: Request, res: Response) {
  return ok(res, { permissions: PERMISSIONS });
}

export async function overridePermissionHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const targetId = req.params.userId ?? '';
  const input = overridePermissionSchema.parse(req.body);

  const record = await usersService.overridePermission(
    auth,
    targetId,
    input.permissionKey,
    input.effect,
    input.reason,
    input.expiresAt,
  );

  await recordAudit(req, {
    action: AuditAction.PERMISSION_CHANGED,
    entityType: 'User',
    entityId: targetId,
    summary: `${input.effect} ${input.permissionKey}${
      record.permission.isSensitive ? ' (sensitive)' : ''
    }: ${input.reason}`,
    after: record,
  });

  return ok(res, { override: record });
}

export async function clearPermissionHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const targetId = req.params.userId ?? '';
  const key = req.params.permissionKey ?? '';

  await usersService.clearPermissionOverride(auth, targetId, key);

  await recordAudit(req, {
    action: AuditAction.PERMISSION_CHANGED,
    entityType: 'User',
    entityId: targetId,
    summary: `Removed the override for ${key}; the role default applies again`,
  });

  return ok(res, { cleared: true });
}

export async function linkChildHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const parentUserId = req.params.userId ?? '';
  const input = linkChildSchema.parse(req.body);

  const link = await usersService.linkParentToStudent(auth, parentUserId, input);

  await recordAudit(req, {
    action: AuditAction.USER_UPDATED,
    entityType: 'ParentStudentLink',
    entityId: link.id,
    summary: `Linked parent ${parentUserId} to student ${input.studentId}`,
    after: link,
  });

  return created(res, { link });
}
