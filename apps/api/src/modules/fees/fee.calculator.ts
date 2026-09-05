/**
 * Fee arithmetic.
 *
 * Money is handled in integer paise throughout, never in floating point. A
 * rupee amount held as a JavaScript number will eventually produce a bill that
 * is off by a paisa, and a parent who is charged 24,000.01 has every right to
 * lose confidence in the whole system. Conversion to and from decimal happens
 * once at the database boundary.
 *
 * Pure functions with no imports, so the arithmetic can be executed and checked
 * independently of Prisma.
 */

export interface FeeComponent {
  label: string;
  /** Whole rupees, as an institute would write it on a fee card. */
  amount: number;
}

export const PAISE = 100;

export function toPaise(rupees: number): number {
  return Math.round(rupees * PAISE);
}

export function toRupees(paise: number): number {
  return Math.round(paise) / PAISE;
}

/** Formats for display in the Indian convention: 1,23,456.00 */
export function formatRupees(paise: number): string {
  const value = Math.abs(toRupees(paise)).toFixed(2);
  const [whole = '0', fraction = '00'] = value.split('.');

  // Indian grouping: last three digits, then pairs.
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;

  return `${paise < 0 ? '-' : ''}₹${grouped}.${fraction}`;
}

export interface InstallmentPlan {
  installmentNo: number;
  /** Paise. */
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  /** Days from the plan start date. */
  dueOffsetDays: number;
}

export interface PlanInput {
  components: FeeComponent[];
  installments: number;
  /** Percentage off the whole fee, 0..100. */
  discountPct?: number;
  /** A flat amount off, in rupees, applied after any percentage. */
  discountFlat?: number;
  /** Days between installments. */
  intervalDays?: number;
}

/**
 * Splits a fee into installments.
 *
 * The remainder lands on the first installment rather than the last. Paying a
 * rupee more at the start and finishing on a round number is easier to explain
 * to a parent than a final bill that does not match the printed schedule.
 */
export function buildInstallments(input: PlanInput): {
  installments: InstallmentPlan[];
  grossTotal: number;
  discountTotal: number;
  netTotal: number;
} {
  const count = Math.max(1, Math.floor(input.installments));
  const interval = input.intervalDays ?? 30;

  const grossTotal = input.components.reduce((sum, c) => sum + toPaise(c.amount), 0);

  const percentDiscount = input.discountPct
    ? Math.round((grossTotal * Math.min(100, Math.max(0, input.discountPct))) / 100)
    : 0;

  const flatDiscount = input.discountFlat ? toPaise(input.discountFlat) : 0;

  // A discount can never exceed the fee itself; a negative bill is not a credit
  // note and should not be created by accident.
  const discountTotal = Math.min(grossTotal, percentDiscount + flatDiscount);
  const netTotal = grossTotal - discountTotal;

  const baseGross = Math.floor(grossTotal / count);
  const baseNet = Math.floor(netTotal / count);

  const grossRemainder = grossTotal - baseGross * count;
  const netRemainder = netTotal - baseNet * count;

  const installments: InstallmentPlan[] = [];

  for (let i = 0; i < count; i += 1) {
    const gross = baseGross + (i === 0 ? grossRemainder : 0);
    const net = baseNet + (i === 0 ? netRemainder : 0);

    installments.push({
      installmentNo: i + 1,
      grossAmount: gross,
      discountAmount: gross - net,
      netAmount: net,
      dueOffsetDays: i * interval,
    });
  }

  return { installments, grossTotal, discountTotal, netTotal };
}

export type InvoiceStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE' | 'WAIVED' | 'CANCELLED';

export interface InvoiceState {
  netAmount: number;
  paidAmount: number;
  /** YYYY-MM-DD */
  dueDate: string;
  status: InvoiceStatus;
}

/**
 * Derives the status an invoice should hold.
 *
 * Waived and cancelled are terminal and set by a human, so they are never
 * recomputed. Everything else follows from what has been paid and whether the
 * date has passed.
 */
export function deriveStatus(state: InvoiceState, today: string): InvoiceStatus {
  if (state.status === 'WAIVED' || state.status === 'CANCELLED') return state.status;

  if (state.paidAmount >= state.netAmount && state.netAmount > 0) return 'PAID';
  if (state.netAmount === 0) return 'PAID';

  const overdue = today > state.dueDate;

  if (state.paidAmount > 0) return overdue ? 'OVERDUE' : 'PARTIAL';
  return overdue ? 'OVERDUE' : 'PENDING';
}

export interface LateFeePolicy {
  /** Days after the due date before anything is charged. */
  graceDays: number;
  /** Flat charge in rupees, applied once. */
  flatRupees: number;
  /** Percentage of the outstanding amount, per period. */
  percentPerPeriod: number;
  /** Days in a charging period. */
  periodDays: number;
  /** Ceiling as a percentage of the outstanding amount. */
  maxPercent: number;
}

export const DEFAULT_LATE_FEE: LateFeePolicy = {
  graceDays: 7,
  flatRupees: 0,
  percentPerPeriod: 1,
  periodDays: 30,
  maxPercent: 10,
};

/**
 * Computes a late fee.
 *
 * Capped, always. An uncapped percentage compounding on an unpaid school fee is
 * how a family that missed one month ends up owing more than the year's
 * tuition, and no institute intends that when they set the rate to 1%.
 */
export function calculateLateFee(
  outstandingPaise: number,
  daysLate: number,
  policy: LateFeePolicy = DEFAULT_LATE_FEE,
): { amount: number; periodsCharged: number; wasCapped: boolean; explanation: string } {
  if (outstandingPaise <= 0 || daysLate <= policy.graceDays) {
    return {
      amount: 0,
      periodsCharged: 0,
      wasCapped: false,
      explanation:
        daysLate <= policy.graceDays && daysLate > 0
          ? `Within the ${policy.graceDays}-day grace period.`
          : 'Nothing outstanding.',
    };
  }

  const chargeableDays = daysLate - policy.graceDays;
  const periods = Math.ceil(chargeableDays / policy.periodDays);

  const flat = toPaise(policy.flatRupees);
  const percentage = Math.round(
    (outstandingPaise * policy.percentPerPeriod * periods) / 100,
  );

  const uncapped = flat + percentage;
  const ceiling = Math.round((outstandingPaise * policy.maxPercent) / 100);
  const amount = Math.min(uncapped, ceiling);

  return {
    amount,
    periodsCharged: periods,
    wasCapped: uncapped > ceiling,
    explanation:
      uncapped > ceiling
        ? `${periods} period(s) late; capped at ${policy.maxPercent}% of the outstanding amount.`
        : `${periods} period(s) late at ${policy.percentPerPeriod}% each.`,
  };
}

export interface PayableInvoice {
  id: string;
  netAmount: number;
  paidAmount: number;
  dueDate: string;
  status: InvoiceStatus;
}

export interface Allocation {
  invoiceId: string;
  applied: number;
  /** What the invoice owes after this payment. */
  remaining: number;
  settles: boolean;
}

/**
 * Spreads one payment across outstanding invoices.
 *
 * Oldest due date first. A parent handing over ten thousand rupees means "put
 * this against what I owe", and clearing the oldest debt first is both the
 * convention and the thing that stops an old invoice sitting overdue while
 * newer ones are settled.
 */
export function allocatePayment(
  amountPaise: number,
  invoices: PayableInvoice[],
): { allocations: Allocation[]; unallocated: number } {
  const payable = invoices
    .filter((invoice) => invoice.status !== 'CANCELLED' && invoice.status !== 'WAIVED')
    .filter((invoice) => invoice.netAmount > invoice.paidAmount)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));

  const allocations: Allocation[] = [];
  let remaining = amountPaise;

  for (const invoice of payable) {
    if (remaining <= 0) break;

    const owed = invoice.netAmount - invoice.paidAmount;
    const applied = Math.min(owed, remaining);

    allocations.push({
      invoiceId: invoice.id,
      applied,
      remaining: owed - applied,
      settles: applied === owed,
    });

    remaining -= applied;
  }

  // An overpayment is reported rather than silently absorbed, so it can be held
  // as a credit or refunded deliberately.
  return { allocations, unallocated: remaining };
}

export interface LedgerLine {
  invoiceId: string;
  invoiceNumber: string;
  installmentNo: number;
  dueDate: string;
  netAmount: number;
  paidAmount: number;
  outstanding: number;
  status: InvoiceStatus;
  daysLate: number;
}

export interface LedgerSummary {
  lines: LedgerLine[];
  totalBilled: number;
  totalPaid: number;
  totalOutstanding: number;
  totalWaived: number;
  overdueCount: number;
  oldestOverdueDays: number;
  nextDue: { dueDate: string; amount: number } | null;
  isClear: boolean;
}

function daysBetween(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

/** Builds the statement a parent sees. */
export function buildLedger(
  invoices: (PayableInvoice & { invoiceNumber: string; installmentNo: number })[],
  today: string,
): LedgerSummary {
  const lines: LedgerLine[] = invoices
    .map((invoice) => {
      const status = deriveStatus(invoice, today);
      const outstanding =
        status === 'WAIVED' || status === 'CANCELLED'
          ? 0
          : Math.max(0, invoice.netAmount - invoice.paidAmount);

      return {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        installmentNo: invoice.installmentNo,
        dueDate: invoice.dueDate,
        netAmount: invoice.netAmount,
        paidAmount: invoice.paidAmount,
        outstanding,
        status,
        daysLate: outstanding > 0 && today > invoice.dueDate ? daysBetween(invoice.dueDate, today) : 0,
      };
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const active = lines.filter((line) => line.status !== 'CANCELLED');
  const waived = lines.filter((line) => line.status === 'WAIVED');

  const totalBilled = active
    .filter((line) => line.status !== 'WAIVED')
    .reduce((sum, line) => sum + line.netAmount, 0);
  const totalPaid = active.reduce((sum, line) => sum + line.paidAmount, 0);
  const totalOutstanding = active.reduce((sum, line) => sum + line.outstanding, 0);
  const totalWaived = waived.reduce((sum, line) => sum + line.netAmount, 0);

  const overdue = lines.filter((line) => line.status === 'OVERDUE');
  const upcoming = lines.find((line) => line.outstanding > 0 && line.dueDate >= today);

  return {
    lines,
    totalBilled,
    totalPaid,
    totalOutstanding,
    totalWaived,
    overdueCount: overdue.length,
    oldestOverdueDays: overdue.reduce((max, line) => Math.max(max, line.daysLate), 0),
    nextDue: upcoming ? { dueDate: upcoming.dueDate, amount: upcoming.outstanding } : null,
    isClear: totalOutstanding === 0,
  };
}

/**
 * Generates a sequential invoice number.
 *
 * Readable and sortable: TSA/2025-26/000142. Institutes reconcile these against
 * paper receipts by eye, so a UUID would be actively unhelpful.
 */
export function invoiceNumber(
  instituteCode: string,
  academicYear: string,
  sequence: number,
): string {
  return `${instituteCode}/${academicYear}/${String(sequence).padStart(6, '0')}`;
}

export function receiptNumber(
  instituteCode: string,
  academicYear: string,
  sequence: number,
): string {
  return `${instituteCode}/RCP/${academicYear}/${String(sequence).padStart(6, '0')}`;
}
