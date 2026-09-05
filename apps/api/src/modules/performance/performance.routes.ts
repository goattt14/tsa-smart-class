import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../../middleware/authorize';
import * as controller from './performance.controller';

const router = Router();

router.use(requireAuth);

const canSeeAStudent = requireAnyPermission(
  'performance.read.own',
  'performance.read.child',
  'performance.read.any',
);

router.get('/overview', canSeeAStudent, asyncHandler(controller.overviewHandler));
router.post('/refresh', canSeeAStudent, asyncHandler(controller.refreshHandler));
router.post('/attempts/:attemptId/ingest', requirePermission('results.publish'), asyncHandler(controller.ingestHandler));
router.post('/recommendations/:recommendationId/dismiss', canSeeAStudent, asyncHandler(controller.dismissHandler));

// Distributions and dated series carry no names, so management may read them.
router.get('/batches/:batchId', requirePermission('analytics.aggregate'), asyncHandler(controller.batchHandler));
router.get('/series', requirePermission('analytics.aggregate'), asyncHandler(controller.seriesHandler));

export default router;
