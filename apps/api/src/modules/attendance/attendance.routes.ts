import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import * as controller from './attendance.controller';

const router = Router();

router.use(requireAuth);

router.get('/sessions/:sessionId/roster', requirePermission('attendance.mark'), asyncHandler(controller.rosterHandler));
router.post('/sessions/:sessionId', requirePermission('attendance.mark'), asyncHandler(controller.markHandler));
router.patch('/:attendanceId', requirePermission('attendance.update'), asyncHandler(controller.correctHandler));

router.get('/report', requirePermission('attendance.read'), asyncHandler(controller.reportHandler));

// Aggregate only — no student is identifiable, so management can watch the trend.
router.get('/trend', requirePermission('analytics.aggregate'), asyncHandler(controller.trendHandler));

export default router;
