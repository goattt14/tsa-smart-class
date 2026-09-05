import { Card, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/States';
import { Meter } from '../../components/ui/Meter';
import { Avatar } from '../../components/ui/Avatar';
import type { ParentDashboardData } from '../../types/api';

export function ParentDashboard({ data }: { data: ParentDashboardData }) {
  if (data.children.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No child linked yet"
          body="Your account is not linked to a student. Ask the institute office to connect it."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <h1 className="font-display text-[27px] font-semibold leading-tight text-ink">
        {data.children.length === 1 ? 'Your child' : 'Your children'}
      </h1>

      {data.children.map((child) => (
        <Card key={child.student.id}>
          <div className="flex items-center gap-3 border-b border-line px-5 py-4">
            <Avatar name={child.student.name} url={child.student.avatarUrl} size={42} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-display text-[17px] font-semibold text-ink">
                {child.student.name}
              </p>
              <p className="text-[12.5px] text-ink-muted">
                {child.student.admissionNumber} · you are the{' '}
                {child.student.relation.toLowerCase()}
              </p>
            </div>
            {child.pendingInvoices > 0 && child.canViewFees ? (
              <Badge tone="caution">
                {child.pendingInvoices} fee{child.pendingInvoices === 1 ? '' : 's'} pending
              </Badge>
            ) : null}
          </div>

          <CardBody className="grid gap-5 sm:grid-cols-2">
            <div>
              <Meter value={child.attendancePct} label="Attendance, last 30 days" />
              <p className="mt-3 text-[13px] text-ink-soft">
                <span className="font-mono font-semibold tabular-nums text-ink">
                  {child.homeworkSubmitted}
                </span>{' '}
                homework submissions on record.
              </p>
            </div>

            <div>
              <p className="mb-1.5 text-[12.5px] font-semibold text-ink">Recent results</p>

              {!child.canViewReport ? (
                <p className="text-[13px] leading-relaxed text-ink-muted">
                  Your account is not set up to view results for this student.
                </p>
              ) : child.recentResults.length === 0 ? (
                <p className="text-[13px] leading-relaxed text-ink-muted">
                  Nothing published yet. Results appear here once the teacher releases them.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {child.recentResults.map((result) => (
                    <li key={result.id} className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-[13px] text-ink-soft">
                        {result.test.subject.name} · {result.test.title}
                      </span>
                      <span className="shrink-0 font-mono text-[13px] font-semibold tabular-nums text-ink">
                        {result.percentage === null ? '—' : `${Math.round(result.percentage)}%`}
                        {result.rank ? (
                          <span className="ml-1.5 text-[11px] font-normal text-ink-muted">
                            #{result.rank}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
