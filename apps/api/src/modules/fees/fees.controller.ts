import { AuditAction, Role } from '@prisma/client';
import type { Request, Response } from 'express';
import { created, ok } from '../../lib/api-response';
import { recordAudit } from '../../lib/audit';
import { unprocessable } from '../../lib/http-error';
import { requireContext } from '../../middleware/authorize';
import {
  createStructureSchema,
  issueInvoicesSchema,
  listInvoicesSchema,
  recordPaymentSchema,
  waiveSchema,
} from './fees.schemas';
import * as service from './fees.service';

export async function createStructureHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = createStructureSchema.parse(req.body);
  const structure = await service.createStructure(auth, input);

  await recordAudit(req, {
    action: AuditAction.FEE_UPDATED,
    entityType: 'FeeStructure',
    entityId: structure.id,
    summary: `Created the fee structure "${structure.name}" for ${structure.academicYear}`,
    after: structure,
  });

  return created(res, { structure });
}

export async function listStructuresHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  return ok(res, { structures: await service.listStructures(auth) });
}

export async function issueHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = issueInvoicesSchema.parse(req.body);
  const report = await service.issueInvoices(auth, input);

  await recordAudit(req, {
    action: AuditAction.FEE_UPDATED,
    entityType: 'FeeInvoice',
    summary: `Issued invoices to ${report.issued} student(s), ${report.skipped.length} already invoiced`,
    after: { issued: report.issued, totalBilled: report.totalBilled },
  });

  return created(res, report);
}

export async function listInvoicesHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const invoices = await service.listInvoices(auth, listInvoicesSchema.parse(req.query));
  return ok(res, { invoices });
}

export async function ledgerHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const requested = typeof req.query.studentId === 'string' ? req.query.studentId : null;

  const studentId = auth.role === Role.STUDENT ? auth.profileId : requested;
  if (!studentId) throw unprocessable('Pass a studentId, or call this as a student.');

  return ok(res, await service.studentLedger(auth, studentId));
}

export async function paymentHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = recordPaymentSchema.parse(req.body);
  const receipt = await service.recordPayment(auth, input);

  await recordAudit(req, {
    action: AuditAction.PAYMENT_RECORDED,
    entityType: 'Payment',
    entityId: receipt.receiptNumber,
    summary: `Recorded ${receipt.amount} by ${input.method} against ${receipt.allocatedTo.length} invoice(s)`,
    after: receipt,
  });

  return created(res, { receipt });
}

export async function waiveHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = waiveSchema.parse(req.body);
  const invoice = await service.waiveInvoice(auth, req.params.invoiceId ?? '', input.reason);

  await recordAudit(req, {
    action: AuditAction.FEE_UPDATED,
    entityType: 'FeeInvoice',
    entityId: invoice.id,
    summary: `Waived ${invoice.invoiceNumber}: ${input.reason}`,
    after: invoice,
  });

  return ok(res, { invoice });
}

export async function summaryHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  return ok(res, await service.collectionSummary(auth));
}
