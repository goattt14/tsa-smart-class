import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from '../lib/api-client';
import type { DashboardEnvelope } from '../types/api';

/**
 * One place for every query key.
 *
 * Keeping them here means an invalidation after a mutation can never miss a
 * screen because someone typed the key slightly differently.
 */
export const keys = {
  dashboard: ['dashboard'] as const,
  selfStudyToday: ['self-study', 'today'] as const,
  roster: (sessionId: string) => ['attendance', 'roster', sessionId] as const,
  sessions: (from: string, to: string) => ['timetable', 'sessions', from, to] as const,
  tests: ['tests'] as const,
  paper: (testId: string, attemptId: string) => ['tests', testId, attemptId] as const,
  ledger: ['fees', 'ledger'] as const,
  notifications: ['notifications'] as const,
  materials: ['materials'] as const,
  subjects: ['academics', 'subjects'] as const,
  vivaSessions: ['viva', 'sessions'] as const,
};

export function useDashboard() {
  return useQuery({
    queryKey: keys.dashboard,
    queryFn: () => apiGet<DashboardEnvelope>('/dashboard'),
    // The dashboard is the first screen after sign-in and is read far more than
    // it changes, so a short stale window avoids a refetch on every navigation.
    staleTime: 60_000,
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: keys.notifications,
    queryFn: () =>
      apiGet<{
        notifications: {
          id: string;
          category: string;
          title: string;
          body: string;
          actionUrl: string | null;
          readAt: string | null;
          createdAt: string;
        }[];
        unreadCount: number;
        digestHeadline: string | null;
      }>('/notifications?limit=40'),
  });
}

export function useMarkAllRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<{ marked: number }>('/notifications/read-all'),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.notifications });
      void client.invalidateQueries({ queryKey: keys.dashboard });
    },
  });
}

export interface RosterRow {
  studentId: string;
  admissionNumber: string;
  rollNumber: string | null;
  name: string;
  avatarUrl: string | null;
  attendance: { status: string; remarks: string | null } | null;
}

export function useRoster(sessionId: string) {
  return useQuery({
    queryKey: keys.roster(sessionId),
    queryFn: () =>
      apiGet<{
        sessionId: string;
        sessionDate: string;
        subject: string;
        alreadyMarked: boolean;
        roster: RosterRow[];
      }>(`/attendance/sessions/${sessionId}/roster`),
    enabled: sessionId.length > 0,
  });
}

export function useMarkAttendance(sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (entries: { studentId: string; status: string }[]) =>
      apiPost<{ marked: number; updated: number; counts: Record<string, number> }>(
        `/attendance/sessions/${sessionId}`,
        { entries, defaultRemainingToPresent: false },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.roster(sessionId) });
      void client.invalidateQueries({ queryKey: keys.dashboard });
    },
  });
}

export function useSelfStudyToday() {
  return useQuery({
    queryKey: keys.selfStudyToday,
    queryFn: () =>
      apiGet<{
        date: string;
        nowMinutes: number;
        windowOpen: boolean;
        windowMessage: string | null;
        cutoffMin: number;
        blackoutEndMin: number;
        taskShape: { taskCount: number; focusMinPerTask: number; evaluationMinPerTask: number };
        sessions: {
          id: string;
          plannedStartMin: number;
          plannedEndMin: number;
          durationMin: number;
          status: string;
          activeMinutes: number;
          completionPct: number | null;
          rule: { label: string } | null;
          classSession: { subject: { name: string; colorHex: string | null } } | null;
        }[];
      }>('/self-study/today'),
  });
}

export function useStartStudy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => apiPost(`/self-study/sessions/${sessionId}/start`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.selfStudyToday });
    },
  });
}

export function useLedger() {
  return useQuery({
    queryKey: keys.ledger,
    queryFn: () =>
      apiGet<{
        student: { name: string; admissionNumber: string };
        summary: {
          totalBilled: string;
          totalPaid: string;
          totalOutstanding: string;
          overdueCount: number;
          nextDue: { dueDate: string; amount: string } | null;
          isClear: boolean;
        };
        lines: {
          invoiceId: string;
          invoiceNumber: string;
          installmentNo: number;
          dueDate: string;
          status: string;
          netFormatted: string;
          paidFormatted: string;
          outstandingFormatted: string;
          daysLate: number;
        }[];
      }>('/fees/ledger'),
  });
}

export interface TestSummary {
  id: string;
  title: string;
  type: string;
  scheduledAt: string;
  durationMin: number;
  maxMarks: number;
  resultsPublished: boolean;
  subject: { name: string; colorHex: string | null };
  batch: { name: string };
  _count: { questions: number; attempts: number };
}

export function useTests() {
  return useQuery({
    queryKey: keys.tests,
    queryFn: () => apiGet<{ tests: TestSummary[] }>('/tests?limit=50'),
  });
}

export interface PaperQuestion {
  testQuestionId: string;
  displayIndex: number;
  marks: number;
  type: string;
  body: string;
  options: { id: string; text: string }[] | null;
  saved: { responseText: string | null; selectedOption: unknown } | null;
}

export function usePaper(testId: string, attemptId: string) {
  return useQuery({
    queryKey: keys.paper(testId, attemptId),
    queryFn: () =>
      apiGet<{
        title: string;
        durationMin: number;
        maxMarks: number;
        startedAt: string | null;
        status: string;
        questions: PaperQuestion[];
      }>(`/tests/${testId}/attempts/${attemptId}/paper`),
    enabled: testId.length > 0 && attemptId.length > 0,
    // A paper must not be silently refetched mid-attempt; that would reorder
    // questions under the student.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useSaveAnswer(attemptId: string) {
  return useMutation({
    mutationFn: (input: {
      testQuestionId: string;
      responseText?: string | null;
      selectedOption?: string | string[] | null;
    }) => apiPut(`/tests/attempts/${attemptId}/answers`, { ...input, inputMode: 'DIGITAL_TEXT' }),
  });
}

export function useSubmitAttempt(attemptId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiPost<{
        score: number;
        maxMarks: number;
        percentage: number;
        isPassed: boolean | null;
        awaitingReview: number;
        isProvisional: boolean;
      }>(`/tests/attempts/${attemptId}/submit`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.tests });
      void client.invalidateQueries({ queryKey: keys.dashboard });
    },
  });
}

// ---------------------------------------------------------------- viva (AI oral exam)

export interface Subject {
  id: string;
  name: string;
  code: string;
  colorHex: string | null;
  iconKey: string | null;
}

export function useSubjects() {
  return useQuery({
    queryKey: keys.subjects,
    queryFn: () => apiGet<Subject[]>('/academics/subjects?pageSize=100'),
    // The subject list barely changes across a term.
    staleTime: 5 * 60_000,
  });
}

export type VivaDifficulty = 'VERY_EASY' | 'EASY' | 'MEDIUM' | 'HARD' | 'VERY_HARD';

export interface VivaSessionSummary {
  id: string;
  status: string;
  durationMin: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  subject: { name: string; colorHex: string | null } | null;
  topic: { name: string } | null;
}

export function useVivaSessions() {
  return useQuery({
    queryKey: keys.vivaSessions,
    queryFn: () => apiGet<{ sessions: VivaSessionSummary[] }>('/viva?limit=20'),
  });
}

export function useScheduleViva() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { subjectId: string; durationMin: number }) =>
      apiPost<{ session: { id: string; status: string; durationMin: number } }>('/viva', {
        subjectId: input.subjectId,
        durationMin: input.durationMin,
        voiceEnabled: true,
        // Camera/mic monitoring is a separate, opt-in escalation this screen
        // does not offer — keeping the consent flow out of scope for now.
        proctoringEnabled: false,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.vivaSessions });
    },
  });
}

export interface VivaQuestionTurn {
  id: string;
  orderIndex: number;
  body: string;
  difficulty: VivaDifficulty;
  isFollowUp: boolean;
  probesConcept: string | null;
}

export interface VivaTurn {
  finished: boolean;
  question?: VivaQuestionTurn;
  endReason?: string;
  progress: { asked: number; maxQuestions: number; elapsedSec: number; durationMin: number };
}

/**
 * Fetching the next question is a mutation, not a query: each call consumes
 * server-side state (it may create and persist a new question), so it must
 * never be replayed by a background refetch the way a GET could be.
 */
export function useNextVivaTurn() {
  return useMutation({
    mutationFn: (sessionId: string) => apiPost<VivaTurn>(`/viva/${sessionId}/next`),
  });
}

export interface VivaAnswerResult {
  evaluated: boolean;
  score: number | null;
  maxScore: number;
  feedback: {
    whatWentRight: string;
    whatWentWrong: string | null;
    whyItWentWrong: string | null;
    correctApproach: string | null;
    improvementTip: string | null;
  } | null;
  speechNote: string | null;
}

export function useSubmitVivaAnswer() {
  return useMutation({
    mutationFn: (input: {
      questionId: string;
      transcript: string;
      sttProvider?: string;
      durationSec?: number;
    }) =>
      apiPost<VivaAnswerResult>(`/viva/questions/${input.questionId}/answer`, {
        transcript: input.transcript,
        sttProvider: input.sttProvider,
        durationSec: input.durationSec,
      }),
  });
}

export function useFinishViva() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => apiPost(`/viva/${sessionId}/finish`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.vivaSessions });
    },
  });
}
