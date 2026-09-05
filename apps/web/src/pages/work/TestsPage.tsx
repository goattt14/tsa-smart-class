import { useNavigate } from 'react-router-dom';
import { Card, CardHeader } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States';
import { useTests } from '../../hooks/useApi';
import { apiPost, ApiError } from '../../lib/api-client';
import { formatDateTime, relativeDay, subjectColor } from '../../lib/format';
import { useAuth } from '../../auth/AuthProvider';
import { useState } from 'react';

export function TestsPage() {
  const { data, isPending, error, refetch } = useTests();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [starting, setStarting] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (isPending) return <Card><Skeleton rows={5} /></Card>;
  if (error || !data) return <Card><ErrorState error={error} onRetry={() => void refetch()} /></Card>;

  const isStudent = user?.role === 'STUDENT';

  async function begin(testId: string) {
    setStarting(testId);
    setMessage(null);

    try {
      const attempt = await apiPost<{ id: string }>(`/tests/${testId}/attempts`);
      navigate(`/tests/${testId}/attempt/${attempt.id}`);
    } catch (caught) {
      setMessage(caught instanceof ApiError ? caught.message : 'Could not start the test.');
    } finally {
      setStarting(null);
    }
  }

  return (
    <div className="space-y-5">
      <h1 className="font-display text-[27px] font-semibold leading-tight text-ink">Tests</h1>

      {message ? (
        <div className="rounded-card border border-line bg-caution-tint px-5 py-3.5 text-[13.5px] text-caution">
          {message}
        </div>
      ) : null}

      <Card>
        <CardHeader title="Scheduled and past" hint="Newest first" />

        {data.tests.length === 0 ? (
          <EmptyState
            title="No tests yet"
            body={
              isStudent
                ? 'Nothing has been published for your batch.'
                : 'Create a test from the question bank to get started.'
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {data.tests.map((test) => {
              const upcoming = new Date(test.scheduledAt).getTime() > Date.now();

              return (
                <li key={test.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                  <span
                    className="h-10 w-1 shrink-0 rounded-full"
                    style={{ backgroundColor: subjectColor(test.subject.colorHex) }}
                  />

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14.5px] font-medium text-ink">{test.title}</p>
                    <p className="text-[12.5px] text-ink-muted">
                      {test.subject.name} · {test.batch.name} · {test._count.questions} questions ·{' '}
                      {test.maxMarks} marks
                    </p>
                    <p className="mt-0.5 font-mono text-[12px] tabular-nums text-ink-muted">
                      {formatDateTime(test.scheduledAt)} ({relativeDay(test.scheduledAt)})
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {test.resultsPublished ? <Badge tone="positive">results out</Badge> : null}

                    {isStudent && !upcoming && !test.resultsPublished ? (
                      <Button
                        size="sm"
                        loading={starting === test.id}
                        onClick={() => void begin(test.id)}
                      >
                        Start
                      </Button>
                    ) : null}

                    {isStudent && upcoming ? <Badge tone="caution">not open yet</Badge> : null}
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
