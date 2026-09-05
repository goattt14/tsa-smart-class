import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { authLimiter } from '../../middleware/rate-limit';
import * as controller from './auth.controller';

const router = Router();

// --- public ----------------------------------------------------------------
router.post('/login', authLimiter, asyncHandler(controller.loginHandler));
router.post('/refresh', asyncHandler(controller.refreshHandler));
router.post('/logout', asyncHandler(controller.logoutHandler));
router.post('/forgot-password', authLimiter, asyncHandler(controller.forgotPasswordHandler));
router.post('/reset-password', authLimiter, asyncHandler(controller.resetPasswordHandler));

// --- authenticated ---------------------------------------------------------
router.get('/me', requireAuth, asyncHandler(controller.meHandler));
router.get('/permissions', requireAuth, asyncHandler(controller.permissionsHandler));
router.post('/change-password', requireAuth, asyncHandler(controller.changePasswordHandler));
router.post('/logout-all', requireAuth, asyncHandler(controller.logoutAllHandler));
router.get('/sessions', requireAuth, asyncHandler(controller.sessionsHandler));
router.delete('/sessions/:sessionId', requireAuth, asyncHandler(controller.revokeSessionHandler));

export default router;
