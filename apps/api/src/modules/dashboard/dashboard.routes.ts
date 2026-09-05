import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requireAnyPermission } from '../../middleware/authorize';
import * as controller from './dashboard.controller';

const router = Router();

router.use(requireAuth);

// The role decides which dashboard is returned, so every signed-in user has a
// home screen without the client needing to know which endpoint to call.
router.get('/', asyncHandler(controller.dashboardHandler));

router.get(
  '/students/:studentId',
  requireAnyPermission('performance.read.own', 'performance.read.child', 'performance.read.any'),
  asyncHandler(controller.studentHandler),
);

export default router;
