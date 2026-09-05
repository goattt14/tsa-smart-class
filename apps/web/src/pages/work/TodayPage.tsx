import { Card, CardHeader } from '../../components/ui/Card';
import { Badge, toneForStatus } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States';
import { Meter } from '../../components/ui/Meter';
import { formatMinutes, formatRange, subjectColor } from '../../lib/format';
import { useSelfStudyToday, useStartStudy } from '../../hooks/useApi';

export function TodayPage() {
  const { data, isPending, error, refetch } = useSelfStudyToday();
  const start = useStartStudy();

  if (isPending) return <Card><Skeleton rows={5} /></Card>;
  if (error || !data) return <Card><ErrorState error={error} onRetry={() => void refetch()} /></Card>;

  const shape = data.taskShape;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[27px] font-semibold leading-tight text-ink">
          Today's study
        </h1>
        <p className="mt-0.5 text-[14px] text-ink-muted">
          {shape.taskCount} tasks · {shape.focusMinPerTask} min focus then{' '}
          {shape.evaluationMinPerTask} min evaluation, each
        </p>
      </div>

      {!data.windowOpen && data.windowMessage ? (
        <div className="rounded-card border border-line bg-caution-tint px-5 py-4">
          <p className="text-[14px] font-semibold text-caution">Study is closed right now</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-ink-soft">{data.windowMessage}</p>
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="Your sessions"
          hint={`New sessions stop at ${formatMinutes(data.cutoffMin)}`}
        />

        {data.sessions.length === 0 ? (
          <EmptyState
            title="Nothing scheduled"
            body="Study sessions appear here after your teacher files the log for a class. If a class happened today, check back shortly."
          />
        ) : (
          <ul className="divide-y divide-line">
            {data.sessions.map((session) => {
              const subject = session.classSession?.subject;
              const canStart =
                data.windowOpen &&
                session.status !== 'COMPLETED' &&
                session.status !== 'SKIPPED_BY_POLICY';

              return (
                <li key={session.id} className="px-5 py-4">
                  <div className="flex items-start gap-3">
                    <span
                      className="mt-0.5 h-10 w-1 shrink-0 rounded-full"
                      style={{ backgroundColor: subjectColor(subject?.colorHex) }}
                    />

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[15px] font-semibold text-ink">
                          {subject?.name ?? 'Self-study'}
                        </p>
                        <Badge tone={toneForStatus(session.status)}>
                          {session.status.toLowerCase().replace(/_/g, ' ')}
                        </Badge>
                      </div>

                      <p className="mt-0.5 font-mono text-[13px] tabular-nums text-ink-muted">
                        {formatRange(session.plannedStartMin, session.plannedEndMin)} ·{' '}
                        {session.durationMin} min
                      </p>

                      {session.rule ? (
                        <p className="mt-1 text-[12.5px] text-ink-muted">{session.rule.label}</p>
                      ) : null}

                      {session.activeMinutes > 0 ? (
                        <div className="mt-2.5 max-w-xs">
                          <Meter value={session.completionPct} label="Progress" />
                        </div>
                      ) : null}
                    </div>

                    {canStart ? (
                      <Button
                        size="sm"
                        loading={start.isPending && start.variables === session.id}
                        onClick={() => start.mutate(session.id)}
                      >
                        {session.status === 'IN_PROGRESS' ? 'Resume' : 'Start'}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
