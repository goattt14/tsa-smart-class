import { Card, CardHeader } from '../../components/ui/Card';
import { Badge, toneForStatus } from '../../components/ui/Badge';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States';
import { useLedger } from '../../hooks/useApi';

export function FeesPage() {
  const { data, isPending, error, refetch } = useLedger();

  if (isPending) return <Card><Skeleton rows={5} /></Card>;
  if (error || !data) return <Card><ErrorState error={error} onRetry={() => void refetch()} /></Card>;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[27px] font-semibold leading-tight text-ink">Fees</h1>
        <p className="mt-0.5 text-[14px] text-ink-muted">
          {data.student.name} · {data.student.admissionNumber}
        </p>
      </div>

      {data.summary.isClear ? (
        <div className="rounded-card border border-line bg-positive-tint px-5 py-4">
          <p className="text-[14px] font-semibold text-positive">Nothing outstanding.</p>
          <p className="mt-0.5 text-[13px] text-ink-soft">All fees are settled. Thank you.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-card border border-line bg-surface-raised px-4 py-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Outstanding</p>
            <p className="mt-1 font-mono text-[24px] font-semibold tabular-nums text-ink">
              {data.summary.totalOutstanding}
            </p>
          </div>
          <div className="rounded-card border border-line bg-surface-raised px-4 py-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Paid so far</p>
            <p className="mt-1 font-mono text-[24px] font-semibold tabular-nums text-positive">
              {data.summary.totalPaid}
            </p>
          </div>
          <div className="rounded-card border border-line bg-surface-raised px-4 py-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Next due</p>
            <p className="mt-1 font-mono text-[24px] font-semibold tabular-nums text-ink">
              {data.summary.nextDue?.amount ?? '—'}
            </p>
            {data.summary.nextDue ? (
              <p className="mt-0.5 text-[12px] text-ink-muted">on {data.summary.nextDue.dueDate}</p>
            ) : null}
          </div>
        </div>
      )}

      {data.summary.overdueCount > 0 ? (
        <div className="rounded-card border border-line bg-caution-tint px-5 py-4">
          <p className="text-[13.5px] leading-relaxed text-ink-soft">
            {data.summary.overdueCount} instalment
            {data.summary.overdueCount === 1 ? ' is' : 's are'} past the due date. If there is a
            difficulty, please speak to the office — arrangements can usually be made.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader title="Statement" hint="Every instalment, oldest first" />

        {data.lines.length === 0 ? (
          <EmptyState title="No invoices yet" body="Nothing has been billed to this student." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-muted">
                  <th className="px-5 py-2.5 font-semibold">Invoice</th>
                  <th className="px-3 py-2.5 font-semibold">Due</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Amount</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Paid</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.lines.map((line) => (
                  <tr key={line.invoiceId}>
                    <td className="px-5 py-3">
                      <p className="font-mono text-[12.5px] text-ink">{line.invoiceNumber}</p>
                      <p className="text-[12px] text-ink-muted">Instalment {line.installmentNo}</p>
                    </td>
                    <td className="px-3 py-3 font-mono text-[12.5px] tabular-nums text-ink-soft">
                      {line.dueDate}
                      {line.daysLate > 0 ? (
                        <span className="block text-[11px] text-critical">
                          {line.daysLate} days late
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-ink">
                      {line.netFormatted}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-ink-soft">
                      {line.paidFormatted}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Badge tone={toneForStatus(line.status)}>{line.status.toLowerCase()}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
