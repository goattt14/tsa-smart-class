import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../../middleware/authorize';
import * as controller from './viva.controller';

const router = Router();

router.use(requireAuth);

const ownOrSupervising = requireAnyPermission('viva.conduct', 'viva.review');

router.get('/', ownOrSupervising, asyncHandler(controller.listHandler));
router.post('/', ownOrSupervising, asyncHandler(controller.scheduleHandler));
router.post('/:sessionId/consent', requirePermission('viva.conduct'), asyncHandler(controller.consentHandler));
router.post('/:sessionId/next', requirePermission('viva.conduct'), asyncHandler(controller.nextHandler));
router.post('/:sessionId/finish', ownOrSupervising, asyncHandler(controller.finishHandler));
router.post('/questions/:questionId/answer', requirePermission('viva.conduct'), asyncHandler(controller.answerHandler));
router.get('/:sessionId/transcript', ownOrSupervising, asyncHandler(controller.transcriptHandler));

export default router;
