import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../../middleware/authorize';
import * as controller from './selfstudy.controller';

const router = Router();

router.use(requireAuth);

// --- the student's own loop ------------------------------------------------
router.get('/today', requireAnyPermission('selfstudy.session.own', 'performance.read.any'), asyncHandler(controller.todayHandler));
router.get('/sessions', requireAnyPermission('selfstudy.session.own', 'performance.read.any'), asyncHandler(controller.listHandler));
router.post('/sessions/:sessionId/start', requirePermission('selfstudy.session.own'), asyncHandler(controller.startHandler));
router.post('/sessions/:sessionId/heartbeat', requirePermission('selfstudy.session.own'), asyncHandler(controller.heartbeatHandler));
router.post('/sessions/:sessionId/complete', requirePermission('selfstudy.session.own'), asyncHandler(controller.completeHandler));
router.post('/sessions/:sessionId/skip', requirePermission('selfstudy.session.own'), asyncHandler(controller.skipHandler));

// --- teaching side ---------------------------------------------------------
router.post('/generate', requirePermission('ai.tasks.generate'), asyncHandler(controller.generateHandler));

// --- configuration ---------------------------------------------------------
router.get('/policy', requirePermission('selfstudy.policy.read'), asyncHandler(controller.getPolicyHandler));
router.patch('/policy', requirePermission('selfstudy.policy.manage'), asyncHandler(controller.updatePolicyHandler));
router.post('/rules', requirePermission('selfstudy.policy.manage'), asyncHandler(controller.createRuleHandler));
router.patch('/rules/:ruleId', requirePermission('selfstudy.policy.manage'), asyncHandler(controller.updateRuleHandler));
router.delete('/rules/:ruleId', requirePermission('selfstudy.policy.manage'), asyncHandler(controller.deleteRuleHandler));

export default router;
