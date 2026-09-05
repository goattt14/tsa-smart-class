import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../../middleware/authorize';
import * as controller from './homework.controller';

const router = Router();

router.use(requireAuth);

router.get('/', requirePermission('homework.read'), asyncHandler(controller.listHandler));
router.post('/', requirePermission('homework.manage'), asyncHandler(controller.createHandler));
router.get('/student', requireAnyPermission('results.read.own', 'performance.read.child', 'performance.read.any'), asyncHandler(controller.studentHandler));

router.post('/:assignmentId/submissions', requirePermission('homework.read'), asyncHandler(controller.submitHandler));
router.get('/:assignmentId/queue', requirePermission('homework.grade'), asyncHandler(controller.queueHandler));
router.post('/submissions/:submissionId/grade', requirePermission('homework.grade'), asyncHandler(controller.gradeHandler));

export default router;
