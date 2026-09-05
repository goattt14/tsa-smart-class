import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { uploadMaterial } from '../../middleware/upload';
import * as controller from './materials.controller';

const router = Router();

router.use(requireAuth);

router.get('/', requirePermission('materials.read'), asyncHandler(controller.listHandler));
router.post(
  '/',
  requirePermission('materials.upload'),
  uploadMaterial.array('files', 10),
  asyncHandler(controller.createHandler),
);

router.get('/:materialId', requirePermission('materials.read'), asyncHandler(controller.getHandler));
router.get('/:materialId/files/:fileId/download', requirePermission('materials.read'), asyncHandler(controller.downloadHandler));
router.patch('/:materialId', requirePermission('materials.upload'), asyncHandler(controller.updateHandler));
router.delete('/:materialId', requirePermission('materials.delete'), asyncHandler(controller.deleteHandler));

export default router;
