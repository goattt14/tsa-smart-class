import { describe, expect, it } from 'vitest';
import {
  allocatePayment,
  buildInstallments,
  buildLedger,
  calculateLateFee,
  DEFAULT_LATE_FEE,
  deriveStatus,
  formatRupees,
  invoiceNumber,
  receiptNumber,
  toPaise,
  toRupees,
  type PayableInvoice,
} from '../modules/fees/fee.calculator';

describe('money is held in integer paise', () => {
  it('converts both ways without loss', () => {
    expect(toPaise(24000)).toBe(2_400_000);
    expect(toRupees(toPaise(1234.56))).toBe(1234.56);
  });

  it('does not drift over repeated addition', () => {
    let total = 0;
    for (let i = 0; i < 100; i += 1) total += toPaise(0.1);
    expect(total).toBe(1000);
  });

  it.each([
    [123456, '\u20b91,23,456.00'],
    [500, '\u20b9500.00'],
    [1234567.89, '\u20b912,34,567.89'],
  ])('formats %s in the Indian convention', (rupees, expected) => {
    expect(formatRupees(toPaise(rupees))).toBe(expected);
  });
});

describe('installments', () => {
  it('always sums back to the total', () => {
    const plan = buildInstallments({ components: [{ label: 'Fee', amount: 10000 }], installments: 3 });
    expect(plan.installments.reduce((sum, i) => sum + i.netAmount, 0)).toBe(toPaise(10000));
  });

  it('puts the remainder on the first installment', () => {
    const plan = buildInstallments({ components: [{ label: 'Fee', amount: 10000 }], installments: 3 });
    expect(plan.installments[0]!.netAmount).toBeGreaterThan(plan.installments[1]!.netAmount);
    expect(plan.installments[1]!.netAmount).toBe(plan.installments[2]!.netAmount);
  });

  it('applies a percentage discount', () => {
    const plan = buildInstallments({ components: [{ label: 'Fee', amount: 20000 }], installments: 2, discountPct: 10 });
    expect(plan.netTotal).toBe(toPaise(18000));
  });

  it('never lets a discount exceed the fee', () => {
    const plan = buildInstallments({ components: [{ label: 'Fee', amount: 5000 }], installments: 1, discountFlat: 9000 });
    expect(plan.netTotal).toBe(0);
  });
});

describe('invoice status', () => {
  const base = { netAmount: toPaise(5000), dueDate: '2026-03-01', status: 'PENDING' as const };

  it.each([
    [0, '2026-02-20', 'PENDING'],
    [0, '2026-03-01', 'PENDING'],
    [0, '2026-03-15', 'OVERDUE'],
    [2000, '2026-02-20', 'PARTIAL'],
    [2000, '2026-03-15', 'OVERDUE'],
    [5000, '2026-03-15', 'PAID'],
  ])('paid %s on %s is %s', (paid, today, expected) => {
    expect(deriveStatus({ ...base, paidAmount: toPaise(paid) }, today)).toBe(expected);
  });

  it('never recomputes a waived invoice', () => {
    expect(deriveStatus({ ...base, paidAmount: 0, status: 'WAIVED' }, '2026-12-01')).toBe('WAIVED');
  });
});

describe('late fees are always capped', () => {
  const outstanding = toPaise(10000);

  it('charges nothing inside the grace period', () => {
    expect(calculateLateFee(outstanding, 7).amount).toBe(0);
  });

  it('charges one percent for one period past grace', () => {
    expect(calculateLateFee(outstanding, 20).amount).toBe(toPaise(100));
  });

  it('caps at the configured ceiling however late', () => {
    const result = calculateLateFee(outstanding, 400);
    expect(result.amount).toBe(toPaise(1000));
    expect(result.wasCapped).toBe(true);
  });

  it('adds a flat component when configured', () => {
    expect(calculateLateFee(outstanding, 20, { ...DEFAULT_LATE_FEE, flatRupees: 50 }).amount).toBe(toPaise(150));
  });
});

describe('payment allocation', () => {
  const invoices: PayableInvoice[] = [
    { id: 'i2', netAmount: toPaise(5000), paidAmount: 0, dueDate: '2026-04-01', status: 'PENDING' },
    { id: 'i1', netAmount: toPaise(5000), paidAmount: 0, dueDate: '2026-03-01', status: 'OVERDUE' },
    { id: 'i3', netAmount: toPaise(5000), paidAmount: 0, dueDate: '2026-05-01', status: 'PENDING' },
  ];

  it('settles the oldest invoice first', () => {
    const result = allocatePayment(toPaise(7500), invoices);
    expect(result.allocations[0]).toMatchObject({ invoiceId: 'i1', settles: true });
    expect(result.allocations[1]).toMatchObject({ invoiceId: 'i2', applied: toPaise(2500) });
  });

  it('reports an overpayment rather than absorbing it', () => {
    expect(allocatePayment(toPaise(20000), invoices).unallocated).toBe(toPaise(5000));
  });

  it('skips waived invoices', () => {
    const withWaived: PayableInvoice[] = [
      { id: 'w', netAmount: toPaise(5000), paidAmount: 0, dueDate: '2026-01-01', status: 'WAIVED' },
      ...invoices,
    ];
    expect(allocatePayment(toPaise(5000), withWaived).allocations[0]?.invoiceId).toBe('i1');
  });
});

describe('the parent statement', () => {
  const ledger = buildLedger(
    [
      { id: 'a', invoiceNumber: 'TSA/2025-26/000001', installmentNo: 1, netAmount: toPaise(5000), paidAmount: toPaise(5000), dueDate: '2026-01-01', status: 'PAID' },
      { id: 'b', invoiceNumber: 'TSA/2025-26/000002', installmentNo: 2, netAmount: toPaise(5000), paidAmount: toPaise(1000), dueDate: '2026-02-01', status: 'PARTIAL' },
      { id: 'c', invoiceNumber: 'TSA/2025-26/000003', installmentNo: 3, netAmount: toPaise(5000), paidAmount: 0, dueDate: '2026-06-01', status: 'PENDING' },
    ],
    '2026-03-11',
  );

  it('totals correctly', () => {
    expect(ledger.totalBilled).toBe(toPaise(15000));
    expect(ledger.totalPaid).toBe(toPaise(6000));
    expect(ledger.totalOutstanding).toBe(toPaise(9000));
  });

  it('counts overdue and days late', () => {
    expect(ledger.overdueCount).toBe(1);
    expect(ledger.lines[1]?.daysLate).toBe(38);
  });

  it('finds the next payment due', () => {
    expect(ledger.nextDue?.dueDate).toBe('2026-06-01');
  });
});

describe('document numbering', () => {
  it('is readable and sortable', () => {
    expect(invoiceNumber('TSA', '2025-26', 142)).toBe('TSA/2025-26/000142');
    expect(receiptNumber('TSA', '2025-26', 7)).toBe('TSA/RCP/2025-26/000007');
  });
});
