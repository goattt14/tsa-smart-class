import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../../middleware/authorize';
import * as controller from './fees.controller';

const router = Router();

router.use(requireAuth);

router.get('/structures', requirePermission('fees.manage'), asyncHandler(controller.listStructuresHandler));
router.post('/structures', requirePermission('fees.manage'), asyncHandler(controller.createStructureHandler));
router.post('/invoices/issue', requirePermission('fees.manage'), asyncHandler(controller.issueHandler));
router.get('/invoices', requirePermission('fees.read.any'), asyncHandler(controller.listInvoicesHandler));
router.post('/invoices/:invoiceId/waive', requirePermission('fees.manage'), asyncHandler(controller.waiveHandler));

router.get('/ledger', requireAnyPermission('fees.read.own', 'fees.read.any'), asyncHandler(controller.ledgerHandler));
router.post('/payments', requirePermission('payments.record'), asyncHandler(controller.paymentHandler));

// Institute totals only; no student is named.
router.get('/summary', requirePermission('analytics.aggregate'), asyncHandler(controller.summaryHandler));

export default router;
