import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Card, CardHeader } from '../../components/ui/Card';
import { StatTile } from '../../components/ui/StatTile';
import { Meter } from '../../components/ui/Meter';
import { EmptyState } from '../../components/ui/States';
import type { ManagementDashboardData } from '../../types/api';

/**
 * The management view.
 *
 * Every figure here is an institute-level aggregate. No student is named
 * anywhere on this screen, and the API backing it cannot return one — that is
 * enforced server-side in three separate places, not by this component.
 */
export function ManagementDashboard({ data }: { data: ManagementDashboardData }) {
  const chartData = data.teacherCompliance.lowest.map((teacher) => ({
    name: teacher.name.split(' ')[0] ?? teacher.name,
    compliance: teacher.compliancePct,
  }));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[27px] font-semibold leading-tight text-ink">
          Institute health
        </h1>
        <p className="mt-0.5 text-[14px] text-ink-muted">
          Last {data.windowDays} days · aggregate figures only
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Attendance"
          value={data.attendancePct === null ? '—' : `${data.attendancePct}%`}
          hint="Across every batch"
          tone={data.attendancePct !== null && data.attendancePct < 75 ? 'caution' : 'positive'}
        />
        <StatTile
          label="Avg test score"
          value={data.academic.averageTestPct === null ? '—' : `${data.academic.averageTestPct}%`}
          hint={`${data.academic.attemptsEvaluated} attempts marked`}
        />
        <StatTile
          label="Self-study done"
          value={data.selfStudy.completionPct === null ? '—' : `${data.selfStudy.completionPct}%`}
          hint={`${data.selfStudy.sessionsPlanned} sessions planned`}
        />
        <StatTile
          label="Collection"
          value={`${data.fees.collectionRatePct}%`}
          hint={`${data.fees.totalOutstanding} outstanding`}
          tone={data.fees.collectionRatePct < 80 ? 'caution' : 'positive'}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Teacher log compliance"
            hint={`Institute average ${data.teacherCompliance.averagePct}%`}
          />
          {chartData.length === 0 ? (
            <EmptyState title="No data yet" body="Compliance appears once classes have been held." />
          ) : (
            <div className="px-3 py-4" style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11, fill: 'var(--ink-muted)' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fontSize: 11, fill: 'var(--ink-muted)' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: 'var(--surface-sunken)' }}
                    contentStyle={{
                      borderRadius: 8,
                      border: '1px solid var(--line)',
                      fontSize: 12,
                    }}
                    formatter={(value: number) => [`${value}%`, 'On time']}
                  />
                  <Bar dataKey="compliance" fill="var(--brand)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Enrolment" />
          <div className="space-y-3.5 px-5 py-5">
            {(['STUDENT', 'TEACHER', 'PARENT', 'ADMIN'] as const).map((role) => (
              <div key={role} className="flex items-baseline justify-between">
                <span className="text-[13.5px] capitalize text-ink-soft">
                  {role.toLowerCase()}s
                </span>
                <span className="font-mono text-[16px] font-semibold tabular-nums text-ink">
                  {data.enrolment[role] ?? 0}
                </span>
              </div>
            ))}
          </div>
          <div className="border-t border-line px-5 py-4">
            <Meter value={data.selfStudy.completionPct} label="Self-study completion" />
          </div>
        </Card>
      </div>

      <div className="rounded-card border border-line bg-surface-raised px-5 py-4">
        <p className="text-[13px] leading-relaxed text-ink-muted">
          This account is limited to aggregate reporting. Individual student records —
          marks, attendance, evaluations and proctoring observations — are not available
          here by design. An administrator can grant scoped access if it is genuinely
          needed, and doing so is recorded in the audit log.
        </p>
      </div>
    </div>
  );
}
