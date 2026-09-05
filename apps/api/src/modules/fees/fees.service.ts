import { FeeStatus, PaymentMethod, PaymentStatus, Prisma, Role } from '@prisma/client';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/http-error';
import { prisma } from '../../lib/prisma';
import { studentVisibilityFilter } from '../../lib/scope';
import { nowInZone, toDateString, toUtcDate } from '../../lib/time';
import type { AuthContext } from '../../types/express';
import {
  allocatePayment,
  buildInstallments,
  buildLedger,
  deriveStatus,
  formatRupees,
  invoiceNumber,
  receiptNumber,
  toPaise,
  toRupees,
  type FeeComponent,
  type PayableInvoice,
} from './fee.calculator';

const TZ = process.env.TZ ?? 'Asia/Kolkata';

/** Prisma Decimal in, integer paise out. Every read goes through this. */
function paiseFrom(value: Prisma.Decimal): number {
  return Math.round(Number(value) * 100);
}

function decimalFrom(paise: number): Prisma.Decimal {
  return new Prisma.Decimal(toRupees(paise).toFixed(2));
}

export async function createStructure(
  auth: AuthContext,
  input: {
    name: string;
    academicYear: string;
    classGroupId?: string | undefined;
    batchId?: string | undefined;
    components: FeeComponent[];
    installments: number;
    intervalDays: number;
  },
) {
  const plan = buildInstallments({
    components: input.components,
    installments: input.installments,
    intervalDays: input.intervalDays,
  });

  return prisma.feeStructure.create({
    data: {
      instituteId: auth.instituteId,
      classGroupId: input.classGroupId ?? null,
      batchId: input.batchId ?? null,
      name: input.name,
      academicYear: input.academicYear,
      components: input.components as unknown as Prisma.InputJsonValue,
      totalAmount: decimalFrom(plan.grossTotal),
      installments: input.installments,
    },
    select: {
      id: true,
      name: true,
      academicYear: true,
      totalAmount: true,
      installments: true,
    },
  });
}

export async function listStructures(auth: AuthContext) {
  return prisma.feeStructure.findMany({
    where: { instituteId: auth.instituteId, isActive: true },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      academicYear: true,
      components: true,
      totalAmount: true,
      installments: true,
      classGroup: { select: { id: true, name: true } },
      batch: { select: { id: true, name: true } },
      _count: { select: { invoices: true } },
    },
  });
}

/**
 * Reserves a block of sequence numbers.
 *
 * Invoice numbers must be gapless and unique, and two admins issuing at once
 * would otherwise both read the same maximum. Counting inside the transaction
 * and relying on the unique constraint means a collision fails loudly rather
 * than producing two invoices with the same number.
 */
async function nextSequence(tx: Prisma.TransactionClient, prefix: string): Promise<number> {
  const last = await tx.feeInvoice.findFirst({
    where: { invoiceNumber: { startsWith: prefix } },
    orderBy: { invoiceNumber: 'desc' },
    select: { invoiceNumber: true },
  });

  if (!last) return 1;

  const tail = last.invoiceNumber.split('/').pop() ?? '0';
  return Number(tail) + 1;
}

export interface IssueReport {
  issued: number;
  skipped: { studentId: string; reason: string }[];
  totalBilled: string;
}

/**
 * Issues invoices to a cohort.
 *
 * Skips rather than fails when a student already has invoices for this
 * structure. Re-running the issue for a batch that gained two new students is
 * the normal case, and it should add two invoices, not error or duplicate
 * twenty.
 */
export async function issueInvoices(
  auth: AuthContext,
  input: {
    feeStructureId: string;
    batchId?: string | undefined;
    studentIds?: string[] | undefined;
    startDate: string;
    discountPct: number;
    discountFlat: number;
  },
): Promise<IssueReport> {
  const structure = await prisma.feeStructure.findFirst({
    where: { id: input.feeStructureId, instituteId: auth.instituteId },
    select: {
      id: true,
      academicYear: true,
      components: true,
      installments: true,
      batchId: true,
      institute: { select: { code: true } },
    },
  });

  if (!structure) throw notFound('Fee structure');

  const batchId = input.batchId ?? structure.batchId;

  const students = input.studentIds
    ? await prisma.studentProfile.findMany({
        where: { id: { in: input.studentIds }, user: { instituteId: auth.instituteId, deletedAt: null } },
        select: { id: true },
      })
    : batchId
      ? await prisma.enrollment
          .findMany({
            where: { batchId, status: 'ACTIVE' },
            select: { studentId: true },
          })
          .then((rows) => rows.map((row) => ({ id: row.studentId })))
      : [];

  if (students.length === 0) {
    throw unprocessable('No students were selected. Pass a batch or a list of students.');
  }

  const components = (structure.components ?? []) as unknown as FeeComponent[];
  const plan = buildInstallments({
    components,
    installments: structure.installments,
    discountPct: input.discountPct,
    discountFlat: input.discountFlat,
  });

  const prefix = `${structure.institute.code}/${structure.academicYear}/`;
  const skipped: { studentId: string; reason: string }[] = [];
  let issued = 0;

  for (const student of students) {
    const existing = await prisma.feeInvoice.count({
      where: { studentId: student.id, feeStructureId: structure.id },
    });

    if (existing > 0) {
      skipped.push({ studentId: student.id, reason: 'Already invoiced for this structure.' });
      continue;
    }

    await prisma.$transaction(async (tx) => {
      let sequence = await nextSequence(tx, prefix);

      for (const installment of plan.installments) {
        const dueDate = new Date(toUtcDate(input.startDate).getTime());
        dueDate.setUTCDate(dueDate.getUTCDate() + installment.dueOffsetDays);

        await tx.feeInvoice.create({
          data: {
            studentId: student.id,
            feeStructureId: structure.id,
            invoiceNumber: invoiceNumber(
              structure.institute.code,
              structure.academicYear,
              sequence,
            ),
            installmentNo: installment.installmentNo,
            grossAmount: decimalFrom(installment.grossAmount),
            discountAmount: decimalFrom(installment.discountAmount),
            netAmount: decimalFrom(installment.netAmount),
            dueDate,
          },
        });

        sequence += 1;
      }
    });

    issued += 1;
  }

  return {
    issued,
    skipped,
    totalBilled: formatRupees(plan.netTotal * issued),
  };
}

export async function listInvoices(
  auth: AuthContext,
  args: {
    studentId?: string | undefined;
    batchId?: string | undefined;
    status?: FeeStatus | undefined;
    overdueOnly: boolean;
    limit: number;
  },
) {
  const { date } = nowInZone(TZ);

  const invoices = await prisma.feeInvoice.findMany({
    where: {
      student: studentVisibilityFilter(auth),
      ...(args.studentId ? { studentId: args.studentId } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(args.batchId
        ? { student: { enrollments: { some: { batchId: args.batchId, status: 'ACTIVE' } } } }
        : {}),
      ...(args.overdueOnly
        ? { dueDate: { lt: toUtcDate(date) }, status: { in: [FeeStatus.PENDING, FeeStatus.PARTIAL, FeeStatus.OVERDUE] } }
        : {}),
    },
    orderBy: { dueDate: 'asc' },
    take: args.limit,
    select: {
      id: true,
      invoiceNumber: true,
      installmentNo: true,
      grossAmount: true,
      discountAmount: true,
      netAmount: true,
      paidAmount: true,
      dueDate: true,
      status: true,
      remarks: true,
      student: {
        select: {
          id: true,
          admissionNumber: true,
          user: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  return invoices.map((invoice) => ({
    ...invoice,
    netFormatted: formatRupees(paiseFrom(invoice.netAmount)),
    outstandingFormatted: formatRupees(
      Math.max(0, paiseFrom(invoice.netAmount) - paiseFrom(invoice.paidAmount)),
    ),
  }));
}

/** The statement a parent sees. */
export async function studentLedger(auth: AuthContext, studentId: string) {
  const visible = await prisma.studentProfile.findFirst({
    where: { AND: [{ id: studentId }, studentVisibilityFilter(auth)] },
    select: {
      id: true,
      admissionNumber: true,
      user: { select: { firstName: true, lastName: true } },
    },
  });

  if (!visible) throw forbidden('You do not have access to this student.');

  // A parent linked without fee visibility must not see the ledger, even
  // though they can see the child's other records.
  if (auth.role === Role.PARENT) {
    const link = await prisma.parentStudentLink.findFirst({
      where: { parentId: auth.profileId ?? '', studentId, canViewFees: true },
      select: { id: true },
    });
    if (!link) throw forbidden('You are not set up to view fees for this student.');
  }

  const invoices = await prisma.feeInvoice.findMany({
    where: { studentId },
    orderBy: { dueDate: 'asc' },
    select: {
      id: true,
      invoiceNumber: true,
      installmentNo: true,
      netAmount: true,
      paidAmount: true,
      dueDate: true,
      status: true,
      payments: {
        where: { status: PaymentStatus.SUCCESS },
        orderBy: { paidAt: 'desc' },
        select: { id: true, receiptNumber: true, amount: true, method: true, paidAt: true },
      },
    },
  });

  const { date } = nowInZone(TZ);

  const ledger = buildLedger(
    invoices.map((invoice) => ({
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      installmentNo: invoice.installmentNo,
      netAmount: paiseFrom(invoice.netAmount),
      paidAmount: paiseFrom(invoice.paidAmount),
      dueDate: toDateString(invoice.dueDate),
      status: invoice.status,
    })),
    date,
  );

  const paymentsByInvoice = new Map(invoices.map((i) => [i.id, i.payments]));

  return {
    student: {
      id: visible.id,
      name: `${visible.user.firstName} ${visible.user.lastName}`,
      admissionNumber: visible.admissionNumber,
    },
    summary: {
      totalBilled: formatRupees(ledger.totalBilled),
      totalPaid: formatRupees(ledger.totalPaid),
      totalOutstanding: formatRupees(ledger.totalOutstanding),
      totalWaived: formatRupees(ledger.totalWaived),
      overdueCount: ledger.overdueCount,
      oldestOverdueDays: ledger.oldestOverdueDays,
      nextDue: ledger.nextDue
        ? { dueDate: ledger.nextDue.dueDate, amount: formatRupees(ledger.nextDue.amount) }
        : null,
      isClear: ledger.isClear,
    },
    lines: ledger.lines.map((line) => ({
      ...line,
      netFormatted: formatRupees(line.netAmount),
      paidFormatted: formatRupees(line.paidAmount),
      outstandingFormatted: formatRupees(line.outstanding),
      payments: paymentsByInvoice.get(line.invoiceId) ?? [],
    })),
  };
}

export interface PaymentReceipt {
  receiptNumber: string;
  amount: string;
  allocatedTo: { invoiceNumber: string; applied: string; settled: boolean }[];
  unallocated: string;
  remainingOutstanding: string;
}

/**
 * Records a payment and spreads it across what is owed.
 *
 * A single payment can settle several installments, so the money is allocated
 * oldest-first and one Payment row is written per invoice it touches. That
 * keeps every receipt traceable to the invoice it paid rather than leaving a
 * lump sum floating against the student.
 */
export async function recordPayment(
  auth: AuthContext,
  input: {
    studentId: string;
    amount: number;
    method: PaymentMethod;
    paidAt?: Date | undefined;
    notes?: string | undefined;
    gatewayName?: string | undefined;
    gatewayPaymentId?: string | undefined;
    isTestPayment: boolean;
  },
): Promise<PaymentReceipt> {
  const student = await prisma.studentProfile.findFirst({
    where: { id: input.studentId, user: { instituteId: auth.instituteId, deletedAt: null } },
    select: { id: true, user: { select: { instituteId: true } } },
  });

  if (!student) throw notFound('Student');

  if (input.gatewayPaymentId) {
    const duplicate = await prisma.payment.findFirst({
      where: { gatewayPaymentId: input.gatewayPaymentId },
      select: { id: true },
    });
    // A gateway that retries its webhook must not charge the family twice.
    if (duplicate) throw conflict('That gateway payment has already been recorded.');
  }

  const institute = await prisma.institute.findUniqueOrThrow({
    where: { id: auth.instituteId },
    select: { code: true, academicYear: true },
  });

  const open = await prisma.feeInvoice.findMany({
    where: { studentId: input.studentId },
    select: {
      id: true,
      invoiceNumber: true,
      netAmount: true,
      paidAmount: true,
      dueDate: true,
      status: true,
    },
  });

  const payable: PayableInvoice[] = open.map((invoice) => ({
    id: invoice.id,
    netAmount: paiseFrom(invoice.netAmount),
    paidAmount: paiseFrom(invoice.paidAmount),
    dueDate: toDateString(invoice.dueDate),
    status: invoice.status,
  }));

  const amountPaise = toPaise(input.amount);
  const { allocations, unallocated } = allocatePayment(amountPaise, payable);

  if (allocations.length === 0) {
    throw unprocessable('This student has nothing outstanding to pay against.');
  }

  const numberByInvoice = new Map(open.map((i) => [i.id, i.invoiceNumber]));
  const { date } = nowInZone(TZ);
  const paidAt = input.paidAt ?? new Date();

  const receipts: PaymentReceipt['allocatedTo'] = [];
  let issuedReceipt = '';

  await prisma.$transaction(async (tx) => {
    const last = await tx.payment.findFirst({
      where: { receiptNumber: { startsWith: `${institute.code}/RCP/` } },
      orderBy: { receiptNumber: 'desc' },
      select: { receiptNumber: true },
    });

    let sequence = last ? Number(last.receiptNumber.split('/').pop() ?? '0') + 1 : 1;

    for (const allocation of allocations) {
      const receipt = receiptNumber(institute.code, institute.academicYear, sequence);
      if (!issuedReceipt) issuedReceipt = receipt;

      await tx.payment.create({
        data: {
          invoiceId: allocation.invoiceId,
          recordedById: auth.userId,
          receiptNumber: receipt,
          amount: decimalFrom(allocation.applied),
          method: input.method,
          status: PaymentStatus.SUCCESS,
          gatewayName: input.gatewayName ?? null,
          gatewayPaymentId: input.gatewayPaymentId ?? null,
          isTestPayment: input.isTestPayment,
          paidAt,
          notes: input.notes ?? null,
        },
      });

      const invoice = payable.find((i) => i.id === allocation.invoiceId);
      const newPaid = (invoice?.paidAmount ?? 0) + allocation.applied;

      await tx.feeInvoice.update({
        where: { id: allocation.invoiceId },
        data: {
          paidAmount: decimalFrom(newPaid),
          status: deriveStatus(
            {
              netAmount: invoice?.netAmount ?? 0,
              paidAmount: newPaid,
              dueDate: invoice?.dueDate ?? date,
              status: invoice?.status ?? 'PENDING',
            },
            date,
          ) as FeeStatus,
        },
      });

      receipts.push({
        invoiceNumber: numberByInvoice.get(allocation.invoiceId) ?? '',
        applied: formatRupees(allocation.applied),
        settled: allocation.settles,
      });

      sequence += 1;
    }
  });

  const stillOwed = payable.reduce(
    (sum, invoice) => sum + Math.max(0, invoice.netAmount - invoice.paidAmount),
    0,
  );

  return {
    receiptNumber: issuedReceipt,
    amount: formatRupees(amountPaise),
    allocatedTo: receipts,
    unallocated: formatRupees(unallocated),
    remainingOutstanding: formatRupees(Math.max(0, stillOwed - (amountPaise - unallocated))),
  };
}

export async function waiveInvoice(auth: AuthContext, invoiceId: string, reason: string) {
  const invoice = await prisma.feeInvoice.findFirst({
    where: { id: invoiceId, student: { user: { instituteId: auth.instituteId } } },
    select: { id: true, invoiceNumber: true, status: true, paidAmount: true },
  });

  if (!invoice) throw notFound('Invoice');

  if (paiseFrom(invoice.paidAmount) > 0) {
    throw unprocessable(
      'Money has already been received against this invoice. Refund it before waiving.',
    );
  }

  return prisma.feeInvoice.update({
    where: { id: invoiceId },
    data: { status: FeeStatus.WAIVED, remarks: reason },
    select: { id: true, invoiceNumber: true, status: true, remarks: true },
  });
}

/**
 * Recomputes overdue status. Run nightly.
 *
 * Without this the stored status drifts and a dashboard reading it reports
 * yesterday's picture as today's.
 */
export async function sweepOverdue(): Promise<number> {
  const { date } = nowInZone(TZ);

  const result = await prisma.feeInvoice.updateMany({
    where: {
      dueDate: { lt: toUtcDate(date) },
      status: { in: [FeeStatus.PENDING, FeeStatus.PARTIAL] },
    },
    data: { status: FeeStatus.OVERDUE },
  });

  return result.count;
}

/** Institute-level collection figures. No student is named. */
export async function collectionSummary(auth: AuthContext) {
  const invoices = await prisma.feeInvoice.findMany({
    where: { student: { user: { instituteId: auth.instituteId } } },
    select: { netAmount: true, paidAmount: true, status: true },
  });

  let billed = 0;
  let collected = 0;
  let overdue = 0;
  let waived = 0;

  for (const invoice of invoices) {
    const net = paiseFrom(invoice.netAmount);
    const paid = paiseFrom(invoice.paidAmount);

    if (invoice.status === FeeStatus.CANCELLED) continue;
    if (invoice.status === FeeStatus.WAIVED) {
      waived += net;
      continue;
    }

    billed += net;
    collected += paid;
    if (invoice.status === FeeStatus.OVERDUE) overdue += net - paid;
  }

  return {
    totalBilled: formatRupees(billed),
    totalCollected: formatRupees(collected),
    totalOutstanding: formatRupees(billed - collected),
    totalOverdue: formatRupees(overdue),
    totalWaived: formatRupees(waived),
    collectionRatePct: billed > 0 ? Math.round((collected / billed) * 1000) / 10 : 100,
    invoiceCount: invoices.length,
  };
}
