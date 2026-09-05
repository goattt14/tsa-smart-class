import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../../middleware/authorize';
import * as controller from './ai.controller';

const router = Router();

router.use(requireAuth);

// --- task generation and review -------------------------------------------
router.post('/tasks/generate', requirePermission('ai.tasks.generate'), asyncHandler(controller.generateHandler));
router.get('/tasks', requirePermission('ai.tasks.review'), asyncHandler(controller.listTasksHandler));
router.get('/tasks/:taskId/review', requirePermission('ai.tasks.review'), asyncHandler(controller.reviewHandler));
router.post('/tasks/:taskId/approve', requirePermission('ai.tasks.review'), asyncHandler(controller.approveHandler));
router.post('/tasks/:taskId/reject', requirePermission('ai.tasks.review'), asyncHandler(controller.rejectHandler));

// --- evaluation ------------------------------------------------------------
router.post('/evaluate', requireAnyPermission('ai.evaluation.read', 'selfstudy.session.own'), asyncHandler(controller.evaluateHandler));
router.post('/evaluations/:evaluationId/override', requirePermission('ai.evaluation.override'), asyncHandler(controller.overrideHandler));
router.get('/evaluations/reliability', requirePermission('ai.evaluation.read'), asyncHandler(controller.reliabilityHandler));

// --- retrieval index -------------------------------------------------------
router.post('/materials/:materialId/index', requirePermission('materials.upload'), asyncHandler(controller.ingestHandler));
router.post('/index/reindex', requirePermission('settings.manage'), asyncHandler(controller.reindexHandler));
router.get('/index/status', requirePermission('materials.read'), asyncHandler(controller.indexStatusHandler));
router.post('/retrieve', requirePermission('materials.read'), asyncHandler(controller.retrieveHandler));

// --- spend -----------------------------------------------------------------
router.get('/usage', requirePermission('analytics.aggregate'), asyncHandler(controller.usageHandler));

export default router;
