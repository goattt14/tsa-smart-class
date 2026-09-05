import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requirePermission, requireSelfOrPermission } from '../../middleware/authorize';
import * as controller from './users.controller';

const router = Router();

router.use(requireAuth);

router.get('/permissions/catalog', requirePermission('permissions.read'), asyncHandler(controller.permissionCatalogHandler));

router.get('/', requirePermission('users.read'), asyncHandler(controller.listUsersHandler));
router.post('/', requirePermission('users.create'), asyncHandler(controller.createUserHandler));

router.get('/:userId', requireSelfOrPermission('userId', 'users.read'), asyncHandler(controller.getUserHandler));
router.patch('/:userId', requireSelfOrPermission('userId', 'users.update'), asyncHandler(controller.updateUserHandler));
router.delete('/:userId', requirePermission('users.disable'), asyncHandler(controller.deleteUserHandler));

router.post('/:userId/status', requirePermission('users.disable'), asyncHandler(controller.setStatusHandler));
router.post('/:userId/reset-password', requirePermission('users.update'), asyncHandler(controller.resetPasswordHandler));

router.post('/:userId/permissions', requirePermission('permissions.assign'), asyncHandler(controller.overridePermissionHandler));
router.delete('/:userId/permissions/:permissionKey', requirePermission('permissions.assign'), asyncHandler(controller.clearPermissionHandler));

router.post('/:userId/children', requirePermission('users.update'), asyncHandler(controller.linkChildHandler));

export default router;
