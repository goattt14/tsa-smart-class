import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge, toneForStatus } from '../../components/ui/Badge';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States';
import { apiGet, apiPost, ApiError } from '../../lib/api-client';
import { subjectColor, formatDateTime, relativeDay } from '../../lib/format';

interface VivaSession {
  id: string;
  status: string;
  durationMin: number;
  overallScore: number | null;
  conceptualScore: number | null;
  communicationScore: number | null;
  summary: string | null;
  startedAt: string | null;
  endedAt: string | null;
  voiceEnabled: boolean;
  proctoringEnabled: boolean;
  subject: { id: string; name: string; colorHex: string | null };
  topic: { id: string; name: string } | null;
  _count: { questions: number };
}

interface Subject {
  id: string;
  name: string;
  colorHex: string | null;
}

export function VivaPage() {
  const queryClient = useQueryClient();
  const [selectedSubject, setSelectedSubject] = useState<string>('');
  const [duration, setDuration] = useState(15);
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [consentGiven, setConsentGiven] = useState(false);

  // List subjects for scheduling - FIXED to handle paginated response
  const subjectsQuery = useQuery({
    queryKey: ['subjects'],
    queryFn: async () => {
      const result = await apiGet<any>('/academics/subjects?pageSize=50');
      // API returns paginated array directly via apiGet
      if (Array.isArray(result)) return { items: result as Subject[] };
      if (result && Array.isArray(result.items)) return { items: result.items as Subject[] };
      if (result && Array.isArray(result.data)) return { items: result.data as Subject[] };
      // Fallback: try to get from subjects field
      if (result && result.subjects) return { items: result.subjects as Subject[] };
      return { items: [] as Subject[] };
    },
  });

  const vivasQuery = useQuery({
    queryKey: ['viva'],
    queryFn: () => apiGet<{ sessions: VivaSession[] }>('/viva?limit=20'),
  });

  const scheduleMutation = useMutation({
    mutationFn: (input: { subjectId: string; durationMin: number }) =>
      apiPost<{ session: { id: string; status: string }; consent: any }>('/viva', {
        subjectId: input.subjectId,
        durationMin: input.durationMin,
        voiceEnabled: true,
        proctoringEnabled: false,
        startDifficulty: 'MEDIUM',
      }),
    onSuccess: (data) => {
      setCurrentSession(data.session.id);
      queryClient.invalidateQueries({ queryKey: ['viva'] });
      if (data.session.status === 'CONSENT_PENDING') {
        setConsentGiven(false);
      } else {
        setConsentGiven(true);
        nextMutation.mutate(data.session.id);
      }
    },
  });

  const consentMutation = useMutation({
    mutationFn: (sessionId: string) =>
      apiPost(`/viva/${sessionId}/consent`, { accepted: true, cameraGranted: false, microphoneGranted: true }),
    onSuccess: (_, sessionId) => {
      setConsentGiven(true);
      nextMutation.mutate(sessionId);
    },
  });

  const [currentQuestion, setCurrentQuestion] = useState<any>(null);
  const [progress, setProgress] = useState<any>(null);
  const [finished, setFinished] = useState(false);
  const [endReason, setEndReason] = useState<string | null>(null);

  const nextMutation = useMutation({
    mutationFn: (sessionId: string) =>
      apiPost<{ finished: boolean; question?: any; endReason?: string; progress: any }>(`/viva/${sessionId}/next`),
    onSuccess: (data) => {
      if (data.finished) {
        setFinished(true);
        setEndReason(data.endReason || null);
        setCurrentQuestion(null);
      } else {
        setCurrentQuestion(data.question);
      }
      setProgress(data.progress);
      setTranscript('');
    },
  });

  const [feedback, setFeedback] = useState<any>(null);
  const answerMutation = useMutation({
    mutationFn: (input: { questionId: string; transcript: string }) =>
      apiPost<{ evaluated: boolean; score: number | null; maxScore: number; feedback: any; speechNote: string | null }>(
        `/viva/questions/${input.questionId}/answer`,
        {
          transcript: input.transcript,
          sttProvider: 'web-speech',
          sttConfidence: 0.9,
          durationSec: 30,
        },
      ),
    onSuccess: (data) => {
      setFeedback(data);
    },
  });

  const finishMutation = useMutation({
    mutationFn: (sessionId: string) => apiPost(`/viva/${sessionId}/finish`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['viva'] });
      setCurrentSession(null);
      setCurrentQuestion(null);
      setFinished(false);
      setFeedback(null);
    },
  });

  useEffect(() => {
    if (!isRecording) return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setIsRecording(false);
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-IN';
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onresult = (event: any) => {
      let text = '';
      for (let i = 0; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
      }
      setTranscript(text);
    };
    recognition.onend = () => setIsRecording(false);
    recognition.start();
    return () => recognition.stop();
  }, [isRecording]);

  if (currentSession && currentQuestion) {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-[22px] font-semibold">Viva - Session</h1>
          <div className="flex gap-2">
            <Badge tone="brand">{progress?.asked || 0} / {progress?.maxQuestions || 12} questions</Badge>
            <Button variant="secondary" size="sm" onClick={() => finishMutation.mutate(currentSession)}>Finish Viva</Button>
          </div>
        </div>

        <Card>
          <CardHeader title={`Question ${currentQuestion.orderIndex + 1}`} hint={`${currentQuestion.difficulty} • ${currentQuestion.isFollowUp ? 'Follow-up' : 'New'}`} />
          <CardBody>
            <p className="text-[18px] leading-relaxed font-medium">{currentQuestion.body}</p>
            {currentQuestion.probesConcept && (
              <p className="mt-2 text-[12px] text-ink-muted">Concept: {currentQuestion.probesConcept}</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Your Answer" hint="Speak or type, explain reasoning" />
          <CardBody className="space-y-4">
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={isRecording ? 'danger' : 'secondary'}
                onClick={() => setIsRecording(!isRecording)}
              >
                {isRecording ? '⏹️ Stop Recording' : '🎤 Start Speaking'}
              </Button>
              <span className="text-[12px] text-ink-muted py-2">Or type below</span>
            </div>

            <textarea
              rows={5}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="Explain your reasoning aloud... The AI marks understanding, not perfect English."
              className="w-full rounded-lg border border-line bg-surface-raised px-3.5 py-3 text-[14.5px] leading-relaxed focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand"
            />

            <Button
              loading={answerMutation.isPending}
              disabled={transcript.trim().length < 3}
              onClick={() => {
                if (currentQuestion) {
                  answerMutation.mutate({ questionId: currentQuestion.id, transcript });
                }
              }}
            >
              Submit Answer
            </Button>

            {feedback && (
              <div className="mt-4 space-y-3 rounded-lg border border-line bg-surface-sunken p-4">
                <div className="flex items-center justify-between">
                  <Badge tone={feedback.score && feedback.score >= 7 ? 'positive' : feedback.score && feedback.score >= 4 ? 'caution' : 'critical'}>
                    {feedback.evaluated ? `${feedback.score}/${feedback.maxScore}` : 'Not evaluated'}
                  </Badge>
                  <span className="text-[12px] text-ink-muted">{feedback.evaluated ? 'AI evaluated' : feedback.speechNote}</span>
                </div>
                {feedback.feedback && (
                  <>
                    <p className="text-[13.5px]"><strong style={{color:'var(--positive)'}}>✅ What went right:</strong> {feedback.feedback.whatWentRight}</p>
                    {feedback.feedback.whatWentWrong && (
                      <p className="text-[13.5px]"><strong style={{color:'var(--critical)'}}>❌ What went wrong:</strong> {feedback.feedback.whatWentWrong}</p>
                    )}
                    {feedback.feedback.whyItWentWrong && (
                      <p className="text-[13.5px]"><strong>💡 Why:</strong> {feedback.feedback.whyItWentWrong}</p>
                    )}
                    {feedback.feedback.correctApproach && (
                      <p className="text-[13.5px]"><strong>✅ Correct approach:</strong> {feedback.feedback.correctApproach}</p>
                    )}
                    {feedback.feedback.improvementTip && (
                      <p className="text-[13.5px]" style={{color:'var(--brand)'}}><strong>🎯 Tip:</strong> {feedback.feedback.improvementTip}</p>
                    )}
                  </>
                )}
                <Button size="sm" variant="secondary" onClick={() => {
                  setFeedback(null);
                  if (currentSession) nextMutation.mutate(currentSession);
                }}>Next Question →</Button>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    );
  }

  if (currentSession && !consentGiven) {
    return (
      <div className="mx-auto max-w-xl space-y-5">
        <h1 className="font-display text-[27px] font-semibold">Viva Consent</h1>
        <Card>
          <CardBody className="space-y-4">
            <p className="text-[14px] leading-relaxed">This viva can be monitored to record observations such as whether a face is visible. No video is stored, only observations.</p>
            <ul className="list-disc pl-5 text-[13px] space-y-1">
              <li>Your camera will be sampled during viva</li>
              <li>No video is stored, only timings</li>
              <li>You can decline - viva will still run without monitoring</li>
              <li>Teacher reviews anything flagged, nothing decided automatically</li>
            </ul>
            <div className="flex gap-3">
              <Button onClick={() => consentMutation.mutate(currentSession)}>✅ I Accept - Start Viva</Button>
              <Button variant="secondary" onClick={() => {
                apiPost(`/viva/${currentSession}/consent`, { accepted: false, cameraGranted: false, microphoneGranted: false }).then(() => {
                  setConsentGiven(true);
                  nextMutation.mutate(currentSession);
                });
              }}>Decline Monitoring, Continue Anyway</Button>
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  if (currentSession && finished) {
    return (
      <div className="mx-auto max-w-xl text-center py-16">
        <h1 className="font-display text-[28px] font-semibold">Viva Finished! 🎉</h1>
        <p className="mt-2 text-[14px] text-ink-muted">{endReason || 'You completed the session'}</p>
        <div className="mt-6 flex justify-center gap-3">
          <Button onClick={() => {
            setCurrentSession(null);
            setFinished(false);
            setEndReason(null);
            vivasQuery.refetch();
          }}>Back to Viva List</Button>
          <Button variant="secondary" onClick={() => {
            if (currentSession) {
              finishMutation.mutate(currentSession);
            }
          }}>View Summary</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[27px] font-semibold leading-tight">Viva - AI Oral Exam</h1>
          <p className="mt-1 text-[14px] text-ink-muted">Adaptive oral examination grounded in teacher's material. Explains, doesn't just mark.</p>
        </div>
        <Badge tone="brand">Main Feature</Badge>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Start New Viva" hint="Choose subject, 15 min default" />
          <CardBody className="space-y-4">
            {subjectsQuery.isPending ? <CardBody><Skeleton rows={3} /></CardBody> : subjectsQuery.isError ? <CardBody><ErrorState error={subjectsQuery.error} /></CardBody> : (
              <>
                <div>
                  <label className="mb-1.5 block text-[13px] font-semibold">Subject</label>
                  <select
                    value={selectedSubject}
                    onChange={(e) => setSelectedSubject(e.target.value)}
                    className="h-11 w-full rounded-lg border border-line bg-surface-raised px-3.5 text-[14px]"
                  >
                    <option value="">Select subject</option>
                    {(subjectsQuery.data?.items || []).map((s: Subject) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  {subjectsQuery.data?.items.length === 0 && (
                    <p className="mt-2 text-[11px] text-caution">No subjects found. Check if /academics/subjects API returns data. Try as Admin user.</p>
                  )}
                </div>
                <div>
                  <label className="mb-1.5 block text-[13px] font-semibold">Duration (minutes)</label>
                  <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="h-11 w-full rounded-lg border border-line bg-surface-raised px-3.5 text-[14px]">
                    <option value={5}>5 min (quick)</option>
                    <option value={10}>10 min</option>
                    <option value={15}>15 min (default)</option>
                    <option value={20}>20 min</option>
                    <option value={30}>30 min (deep)</option>
                  </select>
                </div>
                <Button
                  className="w-full"
                  loading={scheduleMutation.isPending}
                  disabled={!selectedSubject}
                  onClick={() => scheduleMutation.mutate({ subjectId: selectedSubject, durationMin: duration })}
                >
                  🎤 Start Viva
                </Button>
                <p className="text-[11px] text-ink-muted leading-relaxed">Questions come ONLY from teacher's uploaded material (grounded). If no material indexed, teacher needs to upload notes first. Subjects come from your seeded data (Physics, Chemistry, Math).</p>
                {scheduleMutation.isError && (
                  <p className="text-[12px] text-critical">{scheduleMutation.error instanceof ApiError ? scheduleMutation.error.message : 'Failed to schedule'}</p>
                )}
              </>
            )}
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Your Viva History" hint="Recent sessions" />
          {vivasQuery.isPending ? <CardBody><Skeleton rows={5} /></CardBody> : vivasQuery.isError ? <CardBody><ErrorState error={vivasQuery.error} onRetry={() => vivasQuery.refetch()} /></CardBody> : (vivasQuery.data?.sessions.length || 0) === 0 ? (
            <CardBody><EmptyState title="No viva yet" body="Start your first AI oral exam. It adapts: strong answer → harder question, weak → easier, thin but correct → probe deeper." /></CardBody>
          ) : (
            <ul className="divide-y divide-line">
              {(vivasQuery.data?.sessions || []).map((session: VivaSession) => (
                <li key={session.id} className="flex items-center gap-3 px-5 py-3.5">
                  <span className="h-10 w-1 shrink-0 rounded-full" style={{ backgroundColor: subjectColor(session.subject.colorHex) }} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14.5px] font-medium">{session.subject.name} {session.topic ? `• ${session.topic.name}` : ''} • {session.durationMin} min</p>
                    <p className="text-[12px] text-ink-muted">{formatDateTime(session.startedAt || session.endedAt || '')} • {session._count.questions} questions • {relativeDay(session.startedAt || '')}</p>
                    {session.summary && <p className="mt-1 text-[12.5px] text-ink-soft line-clamp-2">{session.summary}</p>}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge tone={toneForStatus(session.status)}>{session.status.toLowerCase().replace(/_/g, ' ')}</Badge>
                    {session.overallScore !== null && (
                      <span className="font-mono text-[13px] font-semibold">{Math.round(session.overallScore)} / 100</span>
                    )}
                    {session.status === 'IN_PROGRESS' && (
                      <Button size="sm" variant="secondary" onClick={() => {
                        setCurrentSession(session.id);
                        setConsentGiven(true);
                        nextMutation.mutate(session.id);
                      }}>Resume</Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="rounded-lg border border-line bg-surface-raised p-4">
        <h3 className="font-semibold text-[14px]">How Viva Works (Adaptive)</h3>
        <ul className="mt-2 list-disc pl-5 text-[13px] space-y-1 text-ink-soft">
          <li><strong>Opens at MEDIUM</strong> difficulty, then adapts</li>
          <li><strong>Strong answer (≥75%)</strong> → Steps UP to harder question</li>
          <li><strong>Weak answer (&lt;34%)</strong> → Steps DOWN to find solid ground</li>
          <li><strong>Correct but thin</strong> → Probes: "Why? How do you know?" (max 2 follow-ups)</li>
          <li><strong>2 silent in a row</strong> → Ends kindly, not drilling until give up</li>
          <li><strong>Scoring:</strong> Conceptual 80% + Communication 20% (fluency, not accent)</li>
          <li><strong>Grounded:</strong> Questions ONLY from teacher's material, cites source passage</li>
        </ul>
      </div>
    </div>
  );
}
