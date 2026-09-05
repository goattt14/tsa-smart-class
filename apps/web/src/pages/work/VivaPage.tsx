import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge, type Tone } from '../../components/ui/Badge';
import { Meter } from '../../components/ui/Meter';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States';
import {
  useFinishViva,
  useNextVivaTurn,
  useScheduleViva,
  useSubjects,
  useSubmitVivaAnswer,
  useVivaSessions,
  type VivaAnswerResult,
  type VivaDifficulty,
  type VivaQuestionTurn,
} from '../../hooks/useApi';
import { ApiError } from '../../lib/api-client';
import { env } from '../../config/env';
import { cn } from '../../lib/cn';

const DURATIONS = [10, 15, 20, 30];

const DIFFICULTY_TONE: Record<VivaDifficulty, Tone> = {
  VERY_EASY: 'positive',
  EASY: 'positive',
  MEDIUM: 'brand',
  HARD: 'caution',
  VERY_HARD: 'critical',
};

const DIFFICULTY_LABEL: Record<VivaDifficulty, string> = {
  VERY_EASY: 'Very easy',
  EASY: 'Easy',
  MEDIUM: 'Medium',
  HARD: 'Hard',
  VERY_HARD: 'Very hard',
};

/**
 * Wraps the browser's built-in speech recognizer.
 *
 * Only Chromium browsers expose this today (as the prefixed
 * `webkitSpeechRecognition`), so `supported` must be checked before `start`
 * is ever offered — there is no server-side fallback wired up for viva audio,
 * so an unsupported browser means typing the answer instead, not a broken mic
 * button.
 */
function useSpeechRecognition() {
  const RecognitionCtor = useMemo(
    () => (typeof window === 'undefined' ? undefined : (window.SpeechRecognition ?? window.webkitSpeechRecognition)),
    [],
  );
  const supported = Boolean(RecognitionCtor);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [usedMic, setUsedMic] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(() => {
    if (!RecognitionCtor) return;
    setError(null);
    setTranscript('');
    setUsedMic(true);

    const recognition = new RecognitionCtor();
    recognition.lang = 'en-IN';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let combined = '';
      for (let index = 0; index < event.results.length; index += 1) {
        combined += event.results[index]?.[0]?.transcript ?? '';
      }
      setTranscript(combined.trim());
    };

    recognition.onerror = (event) => {
      setError(
        event.error === 'not-allowed' || event.error === 'permission-denied'
          ? 'Microphone access was blocked. Allow it in your browser, or type your answer instead.'
          : 'Listening stopped unexpectedly. Try again, or type your answer instead.',
      );
      setListening(false);
    };

    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [RecognitionCtor]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const reset = useCallback(() => {
    setTranscript('');
    setUsedMic(false);
    setError(null);
  }, []);

  // Never leave a live microphone stream behind when the page unmounts.
  useEffect(() => () => recognitionRef.current?.abort(), []);

  return { supported, listening, transcript, setTranscript, usedMic, error, start, stop, reset };
}

type Stage = 'setup' | 'active' | 'finished';

export function VivaPage() {
  const [stage, setStage] = useState<Stage>('setup');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [subjectId, setSubjectId] = useState('');
  const [durationMin, setDurationMin] = useState(15);

  const [question, setQuestion] = useState<VivaQuestionTurn | null>(null);
  const [progress, setProgress] = useState<{ asked: number; maxQuestions: number } | null>(null);
  const [result, setResult] = useState<VivaAnswerResult | null>(null);
  const [endReason, setEndReason] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const answerStartedAt = useRef(0);

  const subjects = useSubjects();
  const sessions = useVivaSessions();
  const schedule = useScheduleViva();
  const nextTurn = useNextVivaTurn();
  const submitAnswer = useSubmitVivaAnswer();
  const finish = useFinishViva();
  const speech = useSpeechRecognition();

  function describeError(error: unknown): string {
    return error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
  }

  const advance = useCallback(
    async (id: string) => {
      setLoadError(null);
      setResult(null);
      speech.reset();
      try {
        const turn = await nextTurn.mutateAsync(id);
        setProgress(turn.progress);
        if (turn.finished) {
          setEndReason(turn.endReason ?? null);
          setQuestion(null);
          setStage('finished');
        } else {
          setQuestion(turn.question ?? null);
          answerStartedAt.current = Date.now();
        }
      } catch (error) {
        setLoadError(describeError(error));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- speech.reset is stable, nextTurn identity is stable across renders
    [nextTurn],
  );

  async function handleStart() {
    if (!subjectId) return;
    setLoadError(null);
    try {
      const { session } = await schedule.mutateAsync({ subjectId, durationMin });
      setSessionId(session.id);
      setStage('active');
      await advance(session.id);
    } catch (error) {
      setLoadError(describeError(error));
    }
  }

  async function handleSubmitAnswer() {
    if (!question || !sessionId) return;
    const transcript = speech.transcript.trim();
    if (!transcript) return;

    if (speech.listening) speech.stop();
    setLoadError(null);

    try {
      const outcome = await submitAnswer.mutateAsync({
        questionId: question.id,
        transcript,
        sttProvider: speech.usedMic ? 'web-speech-api' : 'typed',
        durationSec: Math.round((Date.now() - answerStartedAt.current) / 1000),
      });
      setResult(outcome);
    } catch (error) {
      setLoadError(describeError(error));
    }
  }

  async function handleEndEarly() {
    if (!sessionId) return;
    try {
      await finish.mutateAsync(sessionId);
    } catch {
      // Closing the screen for the student matters more than this call
      // succeeding — the server times sessions out on its own regardless.
    }
    setEndReason('STUDENT_DISENGAGED');
    setStage('finished');
  }

  function resetToSetup() {
    setStage('setup');
    setSessionId(null);
    setQuestion(null);
    setResult(null);
    setProgress(null);
    setEndReason(null);
    speech.reset();
  }

  // ------------------------------------------------------------ finished
  if (stage === 'finished') {
    return (
      <Card>
        <CardHeader
          title="Viva complete"
          hint={progress ? `${progress.asked} question${progress.asked === 1 ? '' : 's'} asked` : undefined}
        />
        <CardBody className="py-10 text-center">
          <p className="mx-auto max-w-sm text-[13.5px] leading-relaxed text-ink-muted">
            {endReason === 'TIME_UP'
              ? "Time's up — nicely paced."
              : endReason === 'STUDENT_DISENGAGED'
                ? 'Ended early.'
                : 'The examiner has asked everything it planned to for this session.'}{' '}
            Your teacher can review the transcript and marks once they check in.
          </p>
          <Button className="mt-5" onClick={resetToSetup}>
            Start another viva
          </Button>
        </CardBody>
      </Card>
    );
  }

  // ------------------------------------------------------------ active
  if (stage === 'active') {
    const pct = progress ? Math.round((progress.asked / Math.max(1, progress.maxQuestions)) * 100) : 0;

    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <Card>
          <CardBody className="py-3.5">
            <Meter
              value={pct}
              label={progress ? `Question ${progress.asked} of ~${progress.maxQuestions}` : 'Starting…'}
            />
          </CardBody>
        </Card>

        {loadError ? (
          <Card>
            <CardBody className="flex flex-col items-center gap-3 py-8 text-center">
              <p className="text-[13.5px] text-critical">{loadError}</p>
              <Button variant="secondary" size="sm" onClick={() => sessionId && advance(sessionId)}>
                Try again
              </Button>
            </CardBody>
          </Card>
        ) : null}

        {nextTurn.isPending && !question ? (
          <Card>
            <Skeleton rows={4} />
          </Card>
        ) : question ? (
          <Card>
            <CardHeader
              title={`Question ${question.orderIndex + 1}`}
              hint={question.isFollowUp ? 'Follow-up' : undefined}
              action={
                <Badge tone={DIFFICULTY_TONE[question.difficulty]}>{DIFFICULTY_LABEL[question.difficulty]}</Badge>
              }
            />
            <CardBody>
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{question.body}</p>

              {result ? (
                <div className="mt-5 space-y-3 rounded-lg border border-line bg-surface-sunken p-4">
                  {result.evaluated ? (
                    <>
                      <p className="font-mono text-[22px] font-semibold text-ink">
                        {result.score}
                        <span className="text-[14px] text-ink-muted">/{result.maxScore}</span>
                      </p>
                      {result.feedback ? (
                        <div className="space-y-1.5 text-[13.5px] leading-relaxed text-ink-soft">
                          <p>
                            <span className="font-semibold text-ink">What was right: </span>
                            {result.feedback.whatWentRight}
                          </p>
                          {result.feedback.whatWentWrong ? (
                            <p>
                              <span className="font-semibold text-ink">What was missing: </span>
                              {result.feedback.whatWentWrong}
                            </p>
                          ) : null}
                          {result.feedback.improvementTip ? (
                            <p>
                              <span className="font-semibold text-ink">Tip: </span>
                              {result.feedback.improvementTip}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-[13.5px] text-ink-muted">
                      {result.speechNote ?? 'That answer was not counted against you.'}
                    </p>
                  )}
                  <Button size="sm" loading={nextTurn.isPending} onClick={() => sessionId && advance(sessionId)}>
                    Next question
                  </Button>
                </div>
              ) : (
                <div className="mt-5 space-y-3">
                  {env.features.voiceViva && speech.supported ? (
                    <div className="flex items-center gap-3">
                      <Button
                        type="button"
                        variant={speech.listening ? 'danger' : 'secondary'}
                        icon={speech.listening ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                        onClick={() => (speech.listening ? speech.stop() : speech.start())}
                      >
                        {speech.listening ? 'Stop recording' : 'Record answer'}
                      </Button>
                      {speech.listening ? (
                        <span className="flex items-center gap-1.5 text-[13px] text-ink-muted">
                          <span className="h-2 w-2 animate-pulse rounded-full bg-critical" /> Listening…
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {speech.error ? <p className="text-[13px] text-critical">{speech.error}</p> : null}

                  <textarea
                    rows={4}
                    value={speech.transcript}
                    onChange={(event) => speech.setTranscript(event.target.value)}
                    placeholder={
                      env.features.voiceViva && speech.supported
                        ? 'Your spoken answer appears here as you talk — you can edit it before sending.'
                        : 'Type your answer.'
                    }
                    className="w-full rounded-lg border border-line bg-surface-raised px-3.5 py-3 text-[14.5px] leading-relaxed text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand"
                  />

                  <div className="flex items-center justify-between">
                    <Button variant="ghost" size="sm" onClick={handleEndEarly}>
                      End viva
                    </Button>
                    <Button
                      size="sm"
                      disabled={!speech.transcript.trim()}
                      loading={submitAnswer.isPending}
                      onClick={handleSubmitAnswer}
                    >
                      Submit answer
                    </Button>
                  </div>
                </div>
              )}
            </CardBody>
          </Card>
        ) : null}
      </div>
    );
  }

  // ------------------------------------------------------------ setup
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card>
        <CardHeader title="AI Viva" hint="An adaptive spoken exam — answer out loud, the examiner adjusts as you go." />
        <CardBody className="space-y-4">
          {!env.features.voiceViva ? (
            <p className="text-[13px] text-caution">
              Voice input is turned off for this deployment — you can still take the viva by typing.
            </p>
          ) : !speech.supported ? (
            <p className="text-[13px] text-ink-muted">
              Your browser does not support in-browser speech recognition, so answers will be typed instead. Chrome
              or Edge on desktop or Android supports voice input.
            </p>
          ) : null}

          <div>
            <label className="mb-1.5 block text-[13px] font-semibold text-ink">Subject</label>
            {subjects.isPending ? (
              <Skeleton rows={1} />
            ) : subjects.error ? (
              <ErrorState error={subjects.error} onRetry={() => void subjects.refetch()} />
            ) : (
              <select
                value={subjectId}
                onChange={(event) => setSubjectId(event.target.value)}
                className="h-11 w-full rounded-lg border border-line bg-surface-raised px-3.5 text-[15px] text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand"
              >
                <option value="">Choose a subject…</option>
                {(subjects.data ?? []).map((subject) => (
                  <option key={subject.id} value={subject.id}>
                    {subject.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-semibold text-ink">Duration</label>
            <div className="flex gap-2">
              {DURATIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDurationMin(value)}
                  className={cn(
                    'h-9 rounded-lg border px-3.5 text-[13.5px] font-semibold',
                    durationMin === value
                      ? 'border-ink bg-ink text-white'
                      : 'border-line bg-surface-raised text-ink-muted hover:border-ink-muted',
                  )}
                >
                  {value} min
                </button>
              ))}
            </div>
          </div>

          {loadError ? <p className="text-[13px] text-critical">{loadError}</p> : null}

          <Button disabled={!subjectId} loading={schedule.isPending || nextTurn.isPending} onClick={handleStart}>
            Start viva
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Past sessions" />
        {sessions.isPending ? (
          <Skeleton rows={3} />
        ) : sessions.error ? (
          <CardBody>
            <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
          </CardBody>
        ) : (sessions.data?.sessions.length ?? 0) === 0 ? (
          <EmptyState title="No vivas yet" body="Start one above — it only takes a few minutes." />
        ) : (
          <ul className="divide-y divide-line">
            {sessions.data!.sessions.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium text-ink">{item.subject?.name ?? 'Subject'}</p>
                  <p className="text-[12.5px] text-ink-muted">
                    {item.durationMin} min · {new Date(item.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <Badge
                  tone={item.status === 'COMPLETED' ? 'positive' : item.status === 'ABANDONED' ? 'critical' : 'brand'}
                >
                  {item.status.replace('_', ' ').toLowerCase()}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
