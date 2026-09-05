import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../../middleware/authorize';
import * as controller from './tests.controller';

const router = Router();

router.use(requireAuth);

// --- authoring -------------------------------------------------------------
router.get('/', requirePermission('tests.read'), asyncHandler(controller.listHandler));
router.post('/', requirePermission('tests.manage'), asyncHandler(controller.createHandler));
router.put('/:testId/questions', requirePermission('tests.manage'), asyncHandler(controller.setQuestionsHandler));
router.post('/:testId/publish', requirePermission('tests.manage'), asyncHandler(controller.publishHandler));
router.post('/:testId/publish-results', requirePermission('results.publish'), asyncHandler(controller.publishResultsHandler));

// --- sitting the paper -----------------------------------------------------
router.post('/:testId/attempts', requirePermission('tests.read'), asyncHandler(controller.startAttemptHandler));
router.get('/:testId/attempts/:attemptId/paper', requirePermission('tests.read'), asyncHandler(controller.paperHandler));
router.put('/attempts/:attemptId/answers', requirePermission('tests.read'), asyncHandler(controller.saveAnswerHandler));
router.post('/attempts/:attemptId/submit', requirePermission('tests.read'), asyncHandler(controller.submitHandler));

// --- marking and results ---------------------------------------------------
router.post('/answers/:answerId/grade', requirePermission('homework.grade'), asyncHandler(controller.gradeHandler));
router.get('/attempts/:attemptId/result', requireAnyPermission('results.read.own', 'results.read.any'), asyncHandler(controller.resultHandler));

export default router;
