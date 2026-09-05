/**
 * The adaptive viva engine.
 *
 * A viva is a conversation, not a quiz: what gets asked next depends on how the
 * last answer went. This module holds that decision — harder, easier, probe
 * deeper, or stop — as pure functions, so the examining behaviour can be read
 * and tested without a model, a microphone or a database.
 *
 * The design goal is a viva that feels fair. A student who is struggling should
 * be brought down to something they can answer rather than drilled until they
 * give up, and a student who is fluent should be stretched rather than asked
 * eight more easy questions.
 */

export type Difficulty = 'VERY_EASY' | 'EASY' | 'MEDIUM' | 'HARD' | 'VERY_HARD';

export const LADDER: Difficulty[] = ['VERY_EASY', 'EASY', 'MEDIUM', 'HARD', 'VERY_HARD'];

export interface VivaPolicy {
  durationMin: number;
  /** Hard ceiling on questions, irrespective of time left. */
  maxQuestions: number;
  /** Below this, a session is too short to score fairly. */
  minQuestions: number;
  /** Seconds budgeted per question, used to project whether more will fit. */
  secondsPerQuestion: number;
  /** Consecutive weak answers before the examiner eases off. */
  strugglingStreak: number;
  /** Maximum follow-ups chained onto one root question. */
  maxFollowUpDepth: number;
}

export const DEFAULT_VIVA_POLICY: VivaPolicy = {
  durationMin: 15,
  maxQuestions: 12,
  minQuestions: 4,
  secondsPerQuestion: 70,
  strugglingStreak: 2,
  maxFollowUpDepth: 2,
};

export interface AnswerOutcome {
  /** 0..1 of the marks available for that question. */
  creditFraction: number;
  difficulty: Difficulty;
  /** True when the student said nothing usable, as opposed to answering badly. */
  wasSilent: boolean;
  /** True when the transcript was too garbled to judge. */
  wasUnintelligible: boolean;
  /** Set when the answer was right but thin — a candidate for probing. */
  wasShallow: boolean;
  isFollowUp: boolean;
  followUpDepth: number;
}

export interface VivaState {
  askedCount: number;
  elapsedSec: number;
  currentDifficulty: Difficulty;
  outcomes: AnswerOutcome[];
}

export const INITIAL_VIVA_STATE: VivaState = {
  askedCount: 0,
  elapsedSec: 0,
  currentDifficulty: 'MEDIUM',
  outcomes: [],
};

export type NextAction =
  | { kind: 'ASK'; difficulty: Difficulty; asFollowUp: false; reason: string }
  | { kind: 'PROBE'; difficulty: Difficulty; asFollowUp: true; reason: string }
  | { kind: 'END'; reason: EndReason; detail: string };

export type EndReason =
  | 'QUESTION_LIMIT'
  | 'TIME_UP'
  | 'NO_TIME_FOR_ANOTHER'
  | 'STUDENT_DISENGAGED';

function step(from: Difficulty, delta: number): Difficulty {
  const index = LADDER.indexOf(from);
  const next = Math.max(0, Math.min(LADDER.length - 1, index + delta));
  return LADDER[next] as Difficulty;
}

/** An answer is weak if it earned less than a third of its marks. */
function isWeak(outcome: AnswerOutcome): boolean {
  return outcome.creditFraction < 0.34;
}

function isStrong(outcome: AnswerOutcome): boolean {
  return outcome.creditFraction >= 0.75;
}

/**
 * Decides what happens after an answer.
 *
 * The order of the checks matters. Ending conditions are evaluated before any
 * difficulty change, so a session never asks one more question it has no time
 * to hear the answer to. Disengagement is checked before difficulty too: if a
 * student has gone silent twice in a row, the useful thing is to stop, not to
 * find an easier question to be met with more silence.
 */
export function decideNext(
  state: VivaState,
  policy: VivaPolicy = DEFAULT_VIVA_POLICY,
): NextAction {
  const budgetSec = policy.durationMin * 60;
  const remainingSec = budgetSec - state.elapsedSec;

  if (state.askedCount >= policy.maxQuestions) {
    return {
      kind: 'END',
      reason: 'QUESTION_LIMIT',
      detail: `Reached the limit of ${policy.maxQuestions} questions.`,
    };
  }

  if (remainingSec <= 0) {
    return { kind: 'END', reason: 'TIME_UP', detail: 'The viva time is up.' };
  }

  // Only stop early for lack of time once the minimum has been asked; a session
  // that ended after two questions could not be scored fairly.
  if (remainingSec < policy.secondsPerQuestion && state.askedCount >= policy.minQuestions) {
    return {
      kind: 'END',
      reason: 'NO_TIME_FOR_ANOTHER',
      detail: `Only ${remainingSec}s remain, less than one question needs.`,
    };
  }

  const recent = state.outcomes.slice(-policy.strugglingStreak);
  const silentRun =
    recent.length >= policy.strugglingStreak &&
    recent.every((outcome) => outcome.wasSilent || outcome.wasUnintelligible);

  if (silentRun && state.askedCount >= policy.minQuestions) {
    return {
      kind: 'END',
      reason: 'STUDENT_DISENGAGED',
      detail:
        'No usable answer to the last few questions. Ending here rather than continuing to ask.',
    };
  }

  const last = state.outcomes[state.outcomes.length - 1];

  // Nothing answered yet: open at the configured starting level.
  if (!last) {
    return {
      kind: 'ASK',
      difficulty: state.currentDifficulty,
      asFollowUp: false,
      reason: 'Opening question.',
    };
  }

  // A correct but thin answer is the one case worth probing. Probing a wrong
  // answer just compounds the failure, and probing a full answer wastes time.
  const canProbe = last.followUpDepth < policy.maxFollowUpDepth;

  if (last.wasShallow && isStrong(last) && canProbe) {
    return {
      kind: 'PROBE',
      difficulty: last.difficulty,
      asFollowUp: true,
      reason: 'The answer was correct but brief; probing whether the reasoning is there.',
    };
  }

  const weakRun =
    state.outcomes.length >= policy.strugglingStreak &&
    state.outcomes.slice(-policy.strugglingStreak).every(isWeak);

  if (weakRun) {
    return {
      kind: 'ASK',
      difficulty: step(state.currentDifficulty, -1),
      asFollowUp: false,
      reason: 'Two weak answers in a row; stepping down to find solid ground.',
    };
  }

  if (isStrong(last)) {
    return {
      kind: 'ASK',
      difficulty: step(state.currentDifficulty, 1),
      asFollowUp: false,
      reason: 'Strong answer; stepping up.',
    };
  }

  if (isWeak(last)) {
    return {
      kind: 'ASK',
      difficulty: step(state.currentDifficulty, -1),
      asFollowUp: false,
      reason: 'Weak answer; stepping down.',
    };
  }

  return {
    kind: 'ASK',
    difficulty: state.currentDifficulty,
    asFollowUp: false,
    reason: 'Partial answer; holding the level.',
  };
}

/** Folds an answer into the running state. */
export function applyAnswer(
  state: VivaState,
  outcome: AnswerOutcome,
  elapsedSec: number,
  nextDifficulty: Difficulty,
): VivaState {
  return {
    askedCount: state.askedCount + 1,
    elapsedSec,
    currentDifficulty: nextDifficulty,
    outcomes: [...state.outcomes, outcome],
  };
}

export interface VivaScore {
  /** 0..100, weighted by question difficulty. */
  conceptualScore: number;
  /** 0..100, from fluency and length rather than correctness. */
  communicationScore: number;
  overallScore: number;
  maxScore: number;
  answered: number;
  silent: number;
  /** True when too little was answered to report a meaningful score. */
  isInconclusive: boolean;
  highestDifficultyCleared: Difficulty | null;
}

const DIFFICULTY_WEIGHT: Record<Difficulty, number> = {
  VERY_EASY: 0.6,
  EASY: 0.8,
  MEDIUM: 1,
  HARD: 1.3,
  VERY_HARD: 1.6,
};

export interface CommunicationSignals {
  /** Words spoken across the whole viva. */
  totalWords: number;
  /** Speech recogniser confidence, averaged. Null when text was typed. */
  avgSttConfidence: number | null;
  /** Seconds the student actually spoke. */
  speakingSec: number;
}

/**
 * Scores a finished viva.
 *
 * Conceptual and communication scores are kept apart on purpose. A student who
 * understands the material but speaks hesitantly, or one whose English is
 * weaker than their physics, should not have those two facts collapsed into a
 * single number that hides both.
 */
export function scoreViva(
  outcomes: AnswerOutcome[],
  signals: CommunicationSignals,
  policy: VivaPolicy = DEFAULT_VIVA_POLICY,
): VivaScore {
  const answered = outcomes.filter((o) => !o.wasSilent && !o.wasUnintelligible);
  const silent = outcomes.length - answered.length;

  if (answered.length === 0) {
    return {
      conceptualScore: 0,
      communicationScore: 0,
      overallScore: 0,
      maxScore: 100,
      answered: 0,
      silent,
      isInconclusive: true,
      highestDifficultyCleared: null,
    };
  }

  const weightedEarned = answered.reduce(
    (sum, o) => sum + o.creditFraction * DIFFICULTY_WEIGHT[o.difficulty],
    0,
  );
  const weightedPossible = answered.reduce((sum, o) => sum + DIFFICULTY_WEIGHT[o.difficulty], 0);

  const conceptualScore = Math.round((weightedEarned / weightedPossible) * 1000) / 10;

  // Communication is judged on whether they spoke enough to be understood, not
  // on accent or vocabulary. Roughly twenty-five words per answer is treated as
  // a full response.
  const expectedWords = Math.max(1, answered.length * 25);
  const fluency = Math.min(1, signals.totalWords / expectedWords);
  const clarity = signals.avgSttConfidence ?? 0.85;
  const communicationScore = Math.round(((fluency * 0.6 + clarity * 0.4) * 100) * 10) / 10;

  const cleared = answered.filter((o) => o.creditFraction >= 0.6);
  const highest = cleared.reduce<Difficulty | null>((best, outcome) => {
    if (!best) return outcome.difficulty;
    return LADDER.indexOf(outcome.difficulty) > LADDER.indexOf(best) ? outcome.difficulty : best;
  }, null);

  // Conceptual understanding is what a viva is for; communication is a
  // secondary signal and weighted accordingly.
  const overall = Math.round((conceptualScore * 0.8 + communicationScore * 0.2) * 10) / 10;

  return {
    conceptualScore,
    communicationScore,
    overallScore: overall,
    maxScore: 100,
    answered: answered.length,
    silent,
    // Below the minimum, a number would look authoritative without being
    // supported by enough evidence to deserve it.
    isInconclusive: answered.length < policy.minQuestions,
    highestDifficultyCleared: highest,
  };
}

/** Plain-language summary of how the session went, for the student. */
export function describeOutcome(score: VivaScore): string {
  if (score.isInconclusive) {
    return score.answered === 0
      ? 'No answers were recorded, so there is nothing to report. Try again when your microphone is working.'
      : `Only ${score.answered} question(s) were answered, which is too few to judge. Try a full session when you have the time.`;
  }

  if (score.conceptualScore >= 80) {
    return 'You explained the ideas clearly and held up under follow-up questions.';
  }
  if (score.conceptualScore >= 60) {
    return 'You have the main ideas. The gaps showed up when the questions went a level deeper.';
  }
  if (score.conceptualScore >= 40) {
    return 'You recognised the topics but the explanations were incomplete. Worth revising before the next one.';
  }
  return 'This topic needs more work before a viva will be useful. Go back over the material with your teacher.';
}
