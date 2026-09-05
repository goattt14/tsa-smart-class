import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import * as controller from './questions.controller';

const router = Router();

router.use(requireAuth);

router.get('/', requirePermission('questions.read'), asyncHandler(controller.listHandler));
router.post('/', requirePermission('questions.manage'), asyncHandler(controller.createHandler));
router.post('/bulk', requirePermission('questions.manage'), asyncHandler(controller.bulkImportHandler));
router.patch('/:questionId', requirePermission('questions.manage'), asyncHandler(controller.updateHandler));
router.delete('/:questionId', requirePermission('questions.manage'), asyncHandler(controller.deleteHandler));

export default router;
