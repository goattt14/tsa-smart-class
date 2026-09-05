import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../../middleware/authorize';
import * as controller from './dailylogs.controller';

const router = Router();

router.use(requireAuth);

router.post('/sessions/:sessionId', requirePermission('dailylog.write'), asyncHandler(controller.submitHandler));
router.get('/', requirePermission('dailylog.read'), asyncHandler(controller.listHandler));
router.get('/outstanding', requirePermission('dailylog.write'), asyncHandler(controller.outstandingHandler));

// Staff-only reporting: names teachers, contains no student data.
router.get('/compliance', requireAnyPermission('dailylog.compliance', 'dailylog.read'), asyncHandler(controller.complianceHandler));

export default router;
