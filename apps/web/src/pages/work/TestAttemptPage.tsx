import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { ErrorState, Skeleton } from '../../components/ui/States';
import { usePaper, useSaveAnswer, useSubmitAttempt } from '../../hooks/useApi';
import { cn } from '../../lib/cn';

/**
 * The test-taking screen.
 *
 * Two things matter more than looks here. First, the timer is only a display —
 * the server decides when time is up, so a student cannot gain minutes by
 * changing their clock. Second, every answer is saved as soon as it is given,
 * so a dropped connection or a closed tab does not cost the paper.
 */
export function TestAttemptPage() {
  const { testId = '', attemptId = '' } = useParams();
  const navigate = useNavigate();

  const { data, isPending, error, refetch } = usePaper(testId, attemptId);
  const save = useSaveAnswer(attemptId);
  const submit = useSubmitAttempt(attemptId);

  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [result, setResult] = useState<{ score: number; maxMarks: number; awaitingReview: number } | null>(null);
  const submittedRef = useRef(false);

  // Seed from anything already saved on the server.
  useEffect(() => {
    if (!data) return;
    const seeded: Record<string, string | string[]> = {};
    for (const question of data.questions) {
      const saved = question.saved;
      if (!saved) continue;
      if (typeof saved.selectedOption === 'string') seeded[question.testQuestionId] = saved.selectedOption;
      else if (Array.isArray(saved.selectedOption)) seeded[question.testQuestionId] = saved.selectedOption as string[];
      else if (saved.responseText) seeded[question.testQuestionId] = saved.responseText;
    }
    setAnswers(seeded);
  }, [data]);

  // Countdown, purely for the student's benefit.
  useEffect(() => {
    if (!data?.startedAt) return;

    const endsAt = new Date(data.startedAt).getTime() + data.durationMin * 60_000;

    const tick = () => {
      const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      setRemaining(left);

      if (left === 0 && !submittedRef.current) {
        submittedRef.current = true;
        void submit.mutateAsync().then(setResult).catch(() => undefined);
      }
    };

    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [data, submit]);

  const question = useMemo(() => data?.questions[index], [data, index]);

  if (isPending) return <Card><Skeleton rows={7} /></Card>;
  if (error || !data) return <Card><ErrorState error={error} onRetry={() => void refetch()} /></Card>;

  if (result) {
    return (
      <Card>
        <CardHeader title="Submitted" hint={data.title} />
        <div className="px-5 py-7 text-center">
          <p className="font-mono text-[40px] font-semibold leading-none tabular-nums text-ink">
            {result.score}
            <span className="text-[22px] text-ink-muted">/{result.maxMarks}</span>
          </p>
          <p className="mx-auto mt-3 max-w-sm text-[13.5px] leading-relaxed text-ink-muted">
            {result.awaitingReview > 0
              ? `${result.awaitingReview} written answer${result.awaitingReview === 1 ? '' : 's'} still need reading, so this total is provisional. Your final result appears once your teacher publishes it.`
              : 'Everything was marked automatically. Your result appears once your teacher publishes it.'}
          </p>
          <Button className="mt-5" variant="secondary" onClick={() => navigate('/tests')}>
            Back to tests
          </Button>
        </div>
      </Card>
    );
  }

  function record(value: string | string[]) {
    if (!question) return;
    setAnswers((prev) => ({ ...prev, [question.testQuestionId]: value }));

    const isChoice = question.type.startsWith('MCQ') || question.type === 'TRUE_FALSE';
    save.mutate(
      isChoice
        ? { testQuestionId: question.testQuestionId, selectedOption: value }
        : { testQuestionId: question.testQuestionId, responseText: value as string },
    );
  }

  const answeredCount = Object.keys(answers).length;
  const minutes = remaining === null ? null : Math.floor(remaining / 60);
  const seconds = remaining === null ? null : remaining % 60;
  const low = remaining !== null && remaining < 300;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* ---------- timer bar ---------- */}
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface-raised px-5 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-[16px] font-semibold text-ink">{data.title}</p>
          <p className="text-[12.5px] text-ink-muted">
            {answeredCount} of {data.questions.length} answered
          </p>
        </div>

        {remaining !== null ? (
          <div
            className={cn(
              'rounded-lg px-3 py-1.5 font-mono text-[18px] font-semibold tabular-nums',
              low ? 'bg-critical-tint text-critical' : 'bg-surface-sunken text-ink',
            )}
            role="timer"
            aria-live={low ? 'polite' : 'off'}
          >
            {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
          </div>
        ) : null}
      </div>

      {/* ---------- question navigator ---------- */}
      <div className="flex flex-wrap gap-1.5">
        {data.questions.map((item, position) => {
          const done = answers[item.testQuestionId] !== undefined;
          return (
            <button
              key={item.testQuestionId}
              type="button"
              onClick={() => setIndex(position)}
              aria-label={`Question ${position + 1}${done ? ', answered' : ''}`}
              aria-current={position === index}
              className={cn(
                'h-8 w-8 rounded-lg border font-mono text-[12px] font-semibold tabular-nums',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                position === index
                  ? 'border-ink bg-ink text-white'
                  : done
                    ? 'border-brand bg-brand-tint text-brand-deep'
                    : 'border-line bg-surface-raised text-ink-muted',
              )}
            >
              {position + 1}
            </button>
          );
        })}
      </div>

      {/* ---------- the question ---------- */}
      {question ? (
        <Card>
          <CardHeader
            title={`Question ${index + 1}`}
            hint={`${question.marks} mark${question.marks === 1 ? '' : 's'}`}
          />

          <div className="px-5 py-5">
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">
              {question.body}
            </p>

            <div className="mt-5 space-y-2">
              {question.options && question.options.length > 0 ? (
                question.options.map((option) => {
                  const current = answers[question.testQuestionId];
                  const multi = question.type === 'MCQ_MULTI';
                  const selected = multi
                    ? Array.isArray(current) && current.includes(option.id)
                    : current === option.id;

                  return (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        if (!multi) {
                          record(option.id);
                          return;
                        }
                        const list = Array.isArray(current) ? current : [];
                        record(
                          list.includes(option.id)
                            ? list.filter((value) => value !== option.id)
                            : [...list, option.id],
                        );
                      }}
                      className={cn(
                        'flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                        selected
                          ? 'border-brand bg-brand-tint'
                          : 'border-line bg-surface-raised hover:border-ink-muted',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center font-mono text-[11px] font-bold',
                          multi ? 'rounded' : 'rounded-full',
                          selected ? 'bg-brand text-white' : 'bg-surface-sunken text-ink-muted',
                        )}
                      >
                        {option.id.toUpperCase()}
                      </span>
                      <span className="text-[14.5px] leading-relaxed text-ink">{option.text}</span>
                    </button>
                  );
                })
              ) : (
                <textarea
                  rows={question.type === 'LONG_ANSWER' ? 10 : 4}
                  value={(answers[question.testQuestionId] as string) ?? ''}
                  onChange={(event) => record(event.target.value)}
                  placeholder="Write your answer, showing your working."
                  className="w-full rounded-lg border border-line bg-surface-raised px-3.5 py-3 text-[14.5px] leading-relaxed text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand"
                />
              )}
            </div>

            {question.type === 'MCQ_MULTI' ? (
              <p className="mt-3 text-[12.5px] text-ink-muted">
                More than one option is correct. Ticking a wrong option scores zero for this
                question, so only choose the ones you are sure of.
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5">
            <Button
              variant="secondary"
              size="sm"
              disabled={index === 0}
              onClick={() => setIndex((value) => value - 1)}
            >
              Previous
            </Button>

            <span className="text-[12px] text-ink-muted">
              {save.isPending ? 'Saving…' : 'Answers save as you go'}
            </span>

            {index === data.questions.length - 1 ? (
              <Button
                size="sm"
                loading={submit.isPending}
                onClick={() => {
                  submittedRef.current = true;
                  void submit.mutateAsync().then(setResult);
                }}
              >
                Submit paper
              </Button>
            ) : (
              <Button size="sm" onClick={() => setIndex((value) => value + 1)}>
                Next
              </Button>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
