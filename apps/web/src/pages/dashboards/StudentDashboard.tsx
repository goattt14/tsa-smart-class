import { Link } from 'react-router-dom';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { StatTile } from '../../components/ui/StatTile';
import { Badge, toneForStatus } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/States';
import { Meter } from '../../components/ui/Meter';
import { DayRail } from '../../components/DayRail';
import { formatRange, relativeDay, subjectColor } from '../../lib/format';
import type { StudentDashboardData } from '../../types/api';

export function StudentDashboard({ data }: { data: StudentDashboardData }) {
  const nextClass = data.today.classes.find((item) => item.endTimeMin > data.today.nowMinutes);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[27px] font-semibold leading-tight text-ink">
          {data.student.name.split(' ')[0]}
        </h1>
        <p className="mt-0.5 text-[14px] text-ink-muted">
          {nextClass
            ? `Next up: ${nextClass.subject.name} at ${formatRange(nextClass.startTimeMin, nextClass.endTimeMin)}`
            : 'No more classes today.'}
        </p>
      </div>

      <Card>
        <CardHeader
          title="Your day"
          hint="Each class sets up the study block below it"
        />
        <DayRail
          classes={data.today.classes}
          study={data.today.selfStudy}
          nowMinutes={data.today.nowMinutes}
        />
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Attendance"
          value={data.attendance30Day.attendancePct === null ? '—' : `${data.attendance30Day.attendancePct}%`}
          hint={`${data.attendance30Day.present} of ${data.attendance30Day.counted} in 30 days`}
          tone={
            data.attendance30Day.attendancePct === null
              ? 'default'
              : data.attendance30Day.attendancePct >= 75
                ? 'positive'
                : 'critical'
          }
        />
        <StatTile label="Homework due" value={data.pendingHomework.length} hint="Not submitted yet" />
        <StatTile label="Tests coming" value={data.upcomingTests.length} hint="Published and scheduled" />
        <StatTile label="Unread" value={data.unreadNotifications} hint="Notifications" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Homework" hint="Soonest first" />
          {data.pendingHomework.length === 0 ? (
            <EmptyState
              title="Nothing pending"
              body="Every piece of homework set for your batch has been submitted."
            />
          ) : (
            <ul className="divide-y divide-line">
              {data.pendingHomework.map((item) => (
                <li key={item.id} className="flex items-center gap-3 px-5 py-3">
                  <span
                    className="h-8 w-1 shrink-0 rounded-full"
                    style={{ backgroundColor: subjectColor(item.subject.colorHex) }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium text-ink">{item.title}</p>
                    <p className="text-[12.5px] text-ink-muted">
                      {item.subject.name} · {item.maxMarks} marks
                    </p>
                  </div>
                  <Badge tone={relativeDay(item.dueAt).includes('ago') ? 'critical' : 'caution'}>
                    due {relativeDay(item.dueAt)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="What to work on" hint="Based on your last few sessions" />
          {data.recommendations.length === 0 ? (
            <EmptyState
              title="Nothing flagged"
              body="Keep going — your topics are all in reasonable shape right now."
            />
          ) : (
            <ul className="divide-y divide-line">
              {data.recommendations.map((item) => (
                <li key={item.id} className="px-5 py-3">
                  <p className="text-[14px] font-medium text-ink">{item.title}</p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">{item.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Recent feedback" />
          {data.recentFeedback.length === 0 ? (
            <EmptyState
              title="No feedback yet"
              body="Once you finish a practice session, the evaluation shows up here."
              action={
                <Link to="/today" className="text-[13px] font-semibold text-brand-deep hover:underline">
                  Go to today
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {data.recentFeedback.map((item) => (
                <li key={item.id} className="px-5 py-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <Badge tone={toneForStatus(item.verdict === 'correct' ? 'COMPLETED' : 'PARTIAL')}>
                      {item.verdict.replace(/_/g, ' ')}
                    </Badge>
                    <span className="font-mono text-[13px] font-semibold tabular-nums text-ink">
                      {item.score}/{item.maxScore}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
                    {item.whatWentRight}
                  </p>
                  {item.improvementTip ? (
                    <p className="mt-1 text-[12.5px] leading-relaxed text-brand-deep">
                      {item.improvementTip}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Upcoming tests" />
          {data.upcomingTests.length === 0 ? (
            <EmptyState title="No tests scheduled" body="Nothing on the calendar for your batch." />
          ) : (
            <ul className="divide-y divide-line">
              {data.upcomingTests.map((item) => (
                <li key={item.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-[14px] font-medium text-ink">{item.title}</p>
                    <span className="shrink-0 text-[12.5px] text-ink-muted">
                      {relativeDay(item.scheduledAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-ink-muted">
                    {item.subject.name} · {item.durationMin} min · {item.maxMarks} marks
                  </p>
                </li>
              ))}
            </ul>
          )}
          <CardBody className="border-t border-line">
            <Meter value={data.attendance30Day.attendancePct} label="Attendance, last 30 days" />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
