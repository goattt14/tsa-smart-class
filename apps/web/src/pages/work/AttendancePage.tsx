import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Avatar } from '../../components/ui/Avatar';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States';
import { useMarkAttendance, useRoster } from '../../hooks/useApi';
import { cn } from '../../lib/cn';

const STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'] as const;
type Status = (typeof STATUSES)[number];

const TONE: Record<Status, string> = {
  PRESENT: 'bg-positive text-white border-positive',
  ABSENT: 'bg-critical text-white border-critical',
  LATE: 'bg-caution text-white border-caution',
  EXCUSED: 'bg-ink-muted text-white border-ink-muted',
};

export function AttendancePage() {
  const [params] = useSearchParams();
  const sessionId = params.get('session') ?? '';

  const { data, isPending, error, refetch } = useRoster(sessionId);
  const mark = useMarkAttendance(sessionId);

  const [marks, setMarks] = useState<Record<string, Status>>({});
  const [saved, setSaved] = useState<string | null>(null);

  // Seed from whatever is already recorded, so re-opening the screen shows the
  // existing marks rather than a blank sheet.
  useEffect(() => {
    if (!data) return;
    const seeded: Record<string, Status> = {};
    for (const row of data.roster) {
      const existing = row.attendance?.status;
      seeded[row.studentId] = (existing as Status) ?? 'PRESENT';
    }
    setMarks(seeded);
  }, [data]);

  if (!sessionId) {
    return (
      <Card>
        <EmptyState
          title="Pick a class first"
          body="Open a class from your dashboard to mark its attendance."
        />
      </Card>
    );
  }

  if (isPending) return <Card><Skeleton rows={8} /></Card>;
  if (error || !data) return <Card><ErrorState error={error} onRetry={() => void refetch()} /></Card>;

  const counts = STATUSES.reduce<Record<string, number>>((acc, status) => {
    acc[status] = Object.values(marks).filter((value) => value === status).length;
    return acc;
  }, {});

  async function save() {
    const entries = Object.entries(marks).map(([studentId, status]) => ({ studentId, status }));
    const result = await mark.mutateAsync(entries);
    setSaved(
      `Saved. ${result.counts.PRESENT ?? 0} present, ${result.counts.ABSENT ?? 0} absent, ${
        result.counts.LATE ?? 0
      } late.`,
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[27px] font-semibold leading-tight text-ink">
          {data.subject}
        </h1>
        <p className="mt-0.5 text-[14px] text-ink-muted">
          {data.sessionDate} · {data.roster.length} students
          {data.alreadyMarked ? ' · already marked once' : ''}
        </p>
      </div>

      {saved ? (
        <div className="rounded-card border border-line bg-positive-tint px-5 py-3.5 text-[13.5px] text-positive">
          {saved}
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="Roll call"
          hint={`${counts.PRESENT ?? 0} present · ${counts.ABSENT ?? 0} absent · ${counts.LATE ?? 0} late`}
          action={
            <Button size="sm" loading={mark.isPending} onClick={() => void save()}>
              Save attendance
            </Button>
          }
        />

        {data.roster.length === 0 ? (
          <EmptyState
            title="Nobody enrolled"
            body="This batch has no active students, so there is nothing to mark."
          />
        ) : (
          <ul className="divide-y divide-line">
            {data.roster.map((row) => (
              <li key={row.studentId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Avatar name={row.name} url={row.avatarUrl} size={34} />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium text-ink">{row.name}</p>
                  <p className="font-mono text-[12px] tabular-nums text-ink-muted">
                    {row.rollNumber ?? row.admissionNumber}
                  </p>
                </div>

                <div className="flex gap-1.5" role="group" aria-label={`Attendance for ${row.name}`}>
                  {STATUSES.map((status) => {
                    const active = marks[row.studentId] === status;
                    return (
                      <button
                        key={status}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setMarks((prev) => ({ ...prev, [row.studentId]: status }))}
                        className={cn(
                          'h-8 rounded-lg border px-2.5 text-[12px] font-semibold transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                          active
                            ? TONE[status]
                            : 'border-line bg-surface-raised text-ink-muted hover:border-ink-muted',
                        )}
                      >
                        {status[0]}
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-[12.5px] leading-relaxed text-ink-muted">
        P present · A absent · L late · E excused. Late still counts as attended. An excused
        absence is removed from the attendance percentage rather than counted against the student.
      </p>
    </div>
  );
}
