import { Link } from 'react-router-dom';
import { Card, CardHeader } from '../../components/ui/Card';
import { StatTile } from '../../components/ui/StatTile';
import { Badge, toneForStatus } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/States';
import { Meter } from '../../components/ui/Meter';
import { formatRange, subjectColor } from '../../lib/format';
import type { TeacherDashboardData } from '../../types/api';

export function TeacherDashboard({ data }: { data: TeacherDashboardData }) {
  const outstanding =
    data.actionsNeeded.dailyLogsOutstanding +
    data.actionsNeeded.submissionsToGrade +
    data.actionsNeeded.aiTasksAwaitingReview;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[27px] font-semibold leading-tight text-ink">Today</h1>
        <p className="mt-0.5 text-[14px] text-ink-muted">
          {data.today.sessions.length === 0
            ? 'No classes on your timetable today.'
            : `${data.today.sessions.length} class${data.today.sessions.length === 1 ? '' : 'es'} scheduled.`}
        </p>
      </div>

      {outstanding > 0 ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile
            label="Logs to file"
            value={data.actionsNeeded.dailyLogsOutstanding}
            hint="Classes taught with no log yet"
            tone={data.actionsNeeded.dailyLogsOutstanding > 0 ? 'caution' : 'default'}
          />
          <StatTile
            label="To grade"
            value={data.actionsNeeded.submissionsToGrade}
            hint="Submissions waiting on marks"
            tone={data.actionsNeeded.submissionsToGrade > 0 ? 'caution' : 'default'}
          />
          <StatTile
            label="AI to review"
            value={data.actionsNeeded.aiTasksAwaitingReview}
            hint="Generated questions need approval"
            tone={data.actionsNeeded.aiTasksAwaitingReview > 0 ? 'caution' : 'default'}
          />
        </div>
      ) : (
        <div className="rounded-card border border-line bg-positive-tint px-5 py-4">
          <p className="text-[14px] font-semibold text-positive">You are up to date.</p>
          <p className="mt-0.5 text-[13px] text-ink-soft">
            Every log is filed, every submission is marked, and nothing is waiting on your review.
          </p>
        </div>
      )}

      <Card>
        <CardHeader title="Your classes today" hint="Mark attendance from here" />
        {data.today.sessions.length === 0 ? (
          <EmptyState title="Nothing today" body="Your timetable has no sessions for today." />
        ) : (
          <ul className="divide-y divide-line">
            {data.today.sessions.map((session) => (
              <li key={session.id} className="flex items-center gap-3 px-5 py-3.5">
                <span
                  className="h-10 w-1 shrink-0 rounded-full"
                  style={{ backgroundColor: subjectColor(session.subject.colorHex) }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium text-ink">
                    {session.subject.name} · {session.batch.name}
                  </p>
                  <p className="font-mono text-[12.5px] tabular-nums text-ink-muted">
                    {formatRange(session.startTimeMin, session.endTimeMin)}
                    {session.room ? ` · ${session.room}` : ''}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {session._count.attendance > 0 ? (
                    <Badge tone="positive">attendance done</Badge>
                  ) : (
                    <Link
                      to={`/attendance?session=${session.id}`}
                      className="rounded-lg bg-brand px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-brand-deep"
                    >
                      Mark attendance
                    </Link>
                  )}
                  {session.dailyLog ? (
                    <Badge tone={toneForStatus(session.dailyLog.compliance)}>
                      {session.dailyLog.compliance.toLowerCase().replace(/_/g, ' ')}
                    </Badge>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Your batches" />
          {data.batches.length === 0 ? (
            <EmptyState title="No batches assigned" body="Ask your administrator to assign you." />
          ) : (
            <ul className="divide-y divide-line">
              {data.batches.map((row) => (
                <li key={`${row.batchId}-${row.subject.name}`} className="flex items-center gap-3 px-5 py-3">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: subjectColor(row.subject.colorHex) }}
                  />
                  <p className="min-w-0 flex-1 truncate text-[14px] text-ink">
                    {row.batchName} · {row.subject.name}
                  </p>
                  <span className="font-mono text-[13px] tabular-nums text-ink-muted">
                    {row.studentCount}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Your daily-log compliance" hint="Last 30 days" />
          <div className="px-5 py-5">
            <Meter value={data.myCompliancePct} label="Filed on time" />
            <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">
              A log is on time when it is filed within 12 hours of the class ending. Pending
              classes are not counted against you.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
