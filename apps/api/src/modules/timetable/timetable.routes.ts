import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import * as controller from './timetable.controller';

const router = Router();

router.use(requireAuth);

router.get('/slots', requirePermission('timetable.read'), asyncHandler(controller.listSlotsHandler));
router.post('/slots', requirePermission('timetable.manage'), asyncHandler(controller.createSlotHandler));
router.patch('/slots/:slotId', requirePermission('timetable.manage'), asyncHandler(controller.updateSlotHandler));
router.delete('/slots/:slotId', requirePermission('timetable.manage'), asyncHandler(controller.deleteSlotHandler));

router.get('/sessions', requirePermission('timetable.read'), asyncHandler(controller.listSessionsHandler));
router.get('/sessions/upcoming', requirePermission('timetable.read'), asyncHandler(controller.upcomingHandler));
router.post('/sessions/generate', requirePermission('timetable.manage'), asyncHandler(controller.generateSessionsHandler));
router.patch('/sessions/:sessionId', requirePermission('timetable.read'), asyncHandler(controller.updateSessionHandler));

export default router;
