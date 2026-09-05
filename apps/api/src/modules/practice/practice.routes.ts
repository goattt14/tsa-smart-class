import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../../middleware/authorize';
import * as controller from './practice.controller';

const router = Router();

router.use(requireAuth);

const ownOrSupervising = requireAnyPermission('selfstudy.session.own', 'performance.read.any');

router.get('/', ownOrSupervising, asyncHandler(controller.listHandler));
router.post('/', ownOrSupervising, asyncHandler(controller.buildHandler));
router.get('/:sessionId', ownOrSupervising, asyncHandler(controller.loadHandler));
router.post('/:sessionId/start', requirePermission('selfstudy.session.own'), asyncHandler(controller.startHandler));
router.post('/:sessionId/submit', requirePermission('selfstudy.session.own'), asyncHandler(controller.submitHandler));
router.put('/questions/:practiceQuestionId/answer', requirePermission('selfstudy.session.own'), asyncHandler(controller.answerHandler));

export default router;
