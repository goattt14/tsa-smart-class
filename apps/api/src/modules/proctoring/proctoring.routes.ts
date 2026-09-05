import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../../middleware/authorize';
import * as controller from './proctoring.controller';

const router = Router();

router.use(requireAuth);

// A student's own client posts its observations; a supervisor may not.
router.post('/events', requireAnyPermission('selfstudy.session.own', 'viva.conduct'), asyncHandler(controller.ingestHandler));

router.get('/queue', requirePermission('proctoring.review'), asyncHandler(controller.queueHandler));
router.get('/sessions/:context/:sessionId', requirePermission('proctoring.review'), asyncHandler(controller.reviewSessionHandler));
router.post('/events/:eventId/review', requirePermission('proctoring.review'), asyncHandler(controller.reviewEventHandler));

// Counts only, no student is identifiable.
router.get('/overview', requirePermission('analytics.aggregate'), asyncHandler(controller.overviewHandler));

export default router;
