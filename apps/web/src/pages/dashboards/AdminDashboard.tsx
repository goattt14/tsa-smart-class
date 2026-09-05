import { Card, CardHeader } from '../../components/ui/Card';
import { StatTile } from '../../components/ui/StatTile';
import { Meter } from '../../components/ui/Meter';
import { formatDate } from '../../lib/format';
import type { AdminDashboardData } from '../../types/api';

export function AdminDashboard({ data }: { data: AdminDashboardData }) {
  const people = data.people;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[27px] font-semibold leading-tight text-ink">
          Institute today
        </h1>
        <p className="mt-0.5 text-[14px] text-ink-muted">{formatDate(data.date)}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Students" value={people.STUDENT ?? 0} hint="Active accounts" />
        <StatTile label="Teachers" value={people.TEACHER ?? 0} hint="Active accounts" />
        <StatTile label="Parents" value={people.PARENT ?? 0} hint="Linked accounts" />
        <StatTile
          label="Classes today"
          value={data.today.classesScheduled}
          hint={`${data.today.attendanceMarked} attendance records`}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Attendance today" hint="Across every batch" />
          <div className="px-5 py-5">
            <Meter value={data.today.attendancePct} label="Present, of those counted" />
            <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">
              Late still counts as attended. Authorised absences are removed from the
              denominator rather than counted against a student.
            </p>
          </div>
        </Card>

        <Card>
          <CardHeader title="Teacher daily logs" hint="Last 7 days" />
          <div className="px-5 py-5">
            {data.dailyLogs7Day.missing === 0 ? (
              <p className="text-[14px] text-positive">
                Every class in the last week has a log filed.
              </p>
            ) : (
              <>
                <p className="font-mono text-[30px] font-semibold leading-none tabular-nums text-caution">
                  {data.dailyLogs7Day.missing}
                </p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
                  classes whose deadline passed with no log filed. AI task generation depends on
                  these, so a missing log stops the evening's work being created.
                </p>
              </>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Fees" hint="Whole institute, all invoices" />
        <div className="grid gap-4 px-5 py-5 sm:grid-cols-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Billed</p>
            <p className="mt-1 font-mono text-[19px] font-semibold tabular-nums text-ink">
              {data.fees.totalBilled}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Collected</p>
            <p className="mt-1 font-mono text-[19px] font-semibold tabular-nums text-positive">
              {data.fees.totalCollected}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Outstanding</p>
            <p className="mt-1 font-mono text-[19px] font-semibold tabular-nums text-ink">
              {data.fees.totalOutstanding}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Overdue</p>
            <p className="mt-1 font-mono text-[19px] font-semibold tabular-nums text-critical">
              {data.fees.totalOverdue}
            </p>
          </div>
        </div>
        <div className="border-t border-line px-5 py-4">
          <Meter value={data.fees.collectionRatePct} label="Collection rate" />
        </div>
      </Card>

      <Card>
        <CardHeader title="AI usage today" hint="Against the daily token budget" />
        <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
          <StatTile label="Calls" value={data.aiToday.calls} hint="Requests made today" />
          <StatTile
            label="Tokens"
            value={data.aiToday.tokens.toLocaleString('en-IN')}
            hint="Counted against the budget"
          />
        </div>
      </Card>
    </div>
  );
}
