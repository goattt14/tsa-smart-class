import { FeeStatus, PaymentMethod } from '@prisma/client';
import { z } from 'zod';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form YYYY-MM-DD');

export const createStructureSchema = z.object({
  name: z.string().trim().min(3).max(120),
  academicYear: z.string().trim().regex(/^\d{4}-\d{2}$/, 'Use the form 2025-26'),
  classGroupId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
  components: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(80),
        amount: z.coerce.number().min(0).max(10_000_000),
      }),
    )
    .min(1)
    .max(20),
  installments: z.coerce.number().int().min(1).max(12).default(1),
  intervalDays: z.coerce.number().int().min(7).max(180).default(30),
});

export const issueInvoicesSchema = z.object({
  feeStructureId: z.string().uuid(),
  batchId: z.string().uuid().optional(),
  studentIds: z.array(z.string().uuid()).max(500).optional(),
  startDate: dateString,
  discountPct: z.coerce.number().min(0).max(100).default(0),
  discountFlat: z.coerce.number().min(0).default(0),
});

export const recordPaymentSchema = z.object({
  studentId: z.string().uuid(),
  amount: z.coerce.number().min(1).max(10_000_000),
  method: z.nativeEnum(PaymentMethod).default(PaymentMethod.CASH),
  paidAt: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional(),
  /** Set when reconciling a gateway callback rather than a counter payment. */
  gatewayName: z.string().trim().max(40).optional(),
  gatewayPaymentId: z.string().trim().max(120).optional(),
  isTestPayment: z.boolean().default(false),
});

export const waiveSchema = z.object({
  reason: z.string().trim().min(5).max(500),
});

export const listInvoicesSchema = z.object({
  studentId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
  status: z.nativeEnum(FeeStatus).optional(),
  overdueOnly: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
