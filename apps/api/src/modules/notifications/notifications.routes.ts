import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import * as controller from './notifications.controller';

const router = Router();

router.use(requireAuth);

// A signed-in user always reaches their own notifications; no extra permission
// key gates reading your own inbox.
router.get('/', asyncHandler(controller.listHandler));
router.post('/read', asyncHandler(controller.markReadHandler));
router.post('/read-all', asyncHandler(controller.markAllReadHandler));
router.get('/preferences', asyncHandler(controller.getPreferencesHandler));
router.patch('/preferences', asyncHandler(controller.updatePreferencesHandler));
router.post('/push/subscribe', asyncHandler(controller.subscribeHandler));
router.post('/push/unsubscribe', asyncHandler(controller.unsubscribeHandler));

router.get('/announcements', asyncHandler(controller.listAnnouncementsHandler));
router.post('/announcements', requirePermission('notifications.send'), asyncHandler(controller.createAnnouncementHandler));
router.delete('/announcements/:announcementId', requirePermission('notifications.send'), asyncHandler(controller.deleteAnnouncementHandler));

export default router;
