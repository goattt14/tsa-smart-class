/**
 * Mastery scoring and recommendations.
 *
 * Turns a stream of individual outcomes into a stable picture of what a student
 * knows, and from that into a small number of concrete next actions.
 *
 * Pure functions, so the thresholds and the weighting are visible and testable
 * rather than buried in a query. A teacher who disagrees with a level should be
 * able to read this file and see exactly why it was awarded.
 */

export type MasteryLevel = 'BEGINNER' | 'DEVELOPING' | 'GOOD' | 'STRONG' | 'MASTERED';
export type Difficulty = 'VERY_EASY' | 'EASY' | 'MEDIUM' | 'HARD' | 'VERY_HARD';
export type RecommendationKind =
  | 'REVISE_TOPIC'
  | 'PRACTICE_MORE'
  | 'ATTEND_DOUBT_SESSION'
  | 'WATCH_MATERIAL'
  | 'ATTEMPT_VIVA'
  | 'SLOW_DOWN'
  | 'ADVANCE';

export interface TopicMasteryState {
  score: number;
  level: MasteryLevel;
  attempts: number;
  correctCount: number;
  consecutiveRight: number;
  avgTimeSec: number | null;
}

export interface AttemptOutcome {
  isCorrect: boolean;
  /** 0..1. A part-marked written answer contributes proportionally. */
  creditFraction?: number;
  difficulty: Difficulty;
  timeTakenSec?: number | null;
}

export const INITIAL_MASTERY: TopicMasteryState = {
  score: 0,
  level: 'BEGINNER',
  attempts: 0,
  correctCount: 0,
  consecutiveRight: 0,
  avgTimeSec: null,
};

/**
 * Harder questions move the score further, in both directions. Getting a
 * very-easy question right says little; getting a hard one right says a lot.
 */
const DIFFICULTY_WEIGHT: Record<Difficulty, number> = {
  VERY_EASY: 0.6,
  EASY: 0.8,
  MEDIUM: 1,
  HARD: 1.3,
  VERY_HARD: 1.6,
};

/**
 * Level bands, plus the evidence each one demands.
 *
 * The attempt minimums exist because a score alone is not evidence: three lucky
 * answers should not read as "Mastered" on a parent's dashboard. A student can
 * hold a high score and still sit at a lower level until they have done enough
 * work to earn it.
 */
const LEVEL_BANDS: { level: MasteryLevel; minScore: number; minAttempts: number }[] = [
  { level: 'MASTERED', minScore: 85, minAttempts: 12 },
  { level: 'STRONG', minScore: 70, minAttempts: 8 },
  { level: 'GOOD', minScore: 50, minAttempts: 4 },
  { level: 'DEVELOPING', minScore: 30, minAttempts: 2 },
  { level: 'BEGINNER', minScore: 0, minAttempts: 0 },
];

export function levelFor(score: number, attempts: number): MasteryLevel {
  for (const band of LEVEL_BANDS) {
    if (score >= band.minScore && attempts >= band.minAttempts) return band.level;
  }
  return 'BEGINNER';
}

/** How much a single outcome may move the score, as attempts accumulate. */
function learningRate(attempts: number): number {
  // Early answers move the needle hard so a new topic settles quickly; later
  // ones move it less so one bad evening does not erase a term of work.
  if (attempts < 5) return 0.35;
  if (attempts < 15) return 0.2;
  return 0.12;
}

function clamp(value: number, low = 0, high = 100): number {
  return Math.max(low, Math.min(high, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Folds one outcome into a topic's mastery.
 *
 * Exponentially weighted rather than a plain average, so recent work counts for
 * more. A student who struggled in September and is fluent in December should
 * read as fluent.
 */
export function applyOutcome(
  current: TopicMasteryState,
  outcome: AttemptOutcome,
): TopicMasteryState {
  const weight = DIFFICULTY_WEIGHT[outcome.difficulty];
  const credit = outcome.creditFraction ?? (outcome.isCorrect ? 1 : 0);

  // The target is where this single answer alone would place the student.
  // Weighting pulls a hard success above 100 and a hard failure below 0 before
  // clamping, which is what makes difficulty matter.
  const target = clamp(credit * 100 * weight, 0, 100 * weight);
  const rate = learningRate(current.attempts);

  const score = clamp(round(current.score + (target - current.score) * rate));
  const attempts = current.attempts + 1;
  const correctCount = current.correctCount + (outcome.isCorrect ? 1 : 0);
  const consecutiveRight = outcome.isCorrect ? current.consecutiveRight + 1 : 0;

  const avgTimeSec =
    outcome.timeTakenSec === null || outcome.timeTakenSec === undefined
      ? current.avgTimeSec
      : Math.round(
          ((current.avgTimeSec ?? outcome.timeTakenSec) * current.attempts + outcome.timeTakenSec) /
            attempts,
        );

  return {
    score,
    level: levelFor(score, attempts),
    attempts,
    correctCount,
    consecutiveRight,
    avgTimeSec,
  };
}

/** Applies a batch of outcomes in order. */
export function applyOutcomes(
  current: TopicMasteryState,
  outcomes: AttemptOutcome[],
): TopicMasteryState {
  return outcomes.reduce(applyOutcome, current);
}

/**
 * The difficulty the next question should be pitched at.
 *
 * One band above current mastery, because work that is always comfortable stops
 * teaching. The consecutive-right streak pushes harder still, and any failure
 * resets that push immediately.
 */
export function recommendDifficulty(state: TopicMasteryState): Difficulty {
  const ladder: Difficulty[] = ['VERY_EASY', 'EASY', 'MEDIUM', 'HARD', 'VERY_HARD'];

  const base =
    state.score >= 85 ? 4 : state.score >= 70 ? 3 : state.score >= 50 ? 2 : state.score >= 30 ? 1 : 0;

  const stretch = state.consecutiveRight >= 3 ? 1 : 0;
  const index = Math.min(ladder.length - 1, base + stretch);

  return ladder[index] as Difficulty;
}

export interface TopicSnapshot {
  topicId: string;
  topicName: string;
  state: TopicMasteryState;
  /** Days since this topic was last assessed, if ever. */
  daysSinceAssessed: number | null;
  /** Whether the batch has covered this topic in class yet. */
  taughtInClass: boolean;
}

export interface Recommendation {
  topicId: string | null;
  kind: RecommendationKind;
  title: string;
  reason: string;
  /** Lower sorts first. */
  priority: number;
}

/**
 * Turns the mastery picture into a short, ordered list of things to do.
 *
 * Capped deliberately: a dashboard showing a student fourteen weaknesses is a
 * dashboard they close. Three or four actionable items get acted on.
 */
export function buildRecommendations(
  topics: TopicSnapshot[],
  maxItems = 4,
): Recommendation[] {
  const out: Recommendation[] = [];

  for (const topic of topics) {
    if (!topic.taughtInClass) continue;

    const { state } = topic;

    // Never assessed, but taught: the gap is evidence, not weakness.
    if (state.attempts === 0) {
      out.push({
        topicId: topic.topicId,
        kind: 'PRACTICE_MORE',
        title: `Try some questions on ${topic.topicName}`,
        reason: 'This was covered in class but you have not practised it yet.',
        priority: 30,
      });
      continue;
    }

    if (state.score < 30) {
      out.push({
        topicId: topic.topicId,
        kind: 'ATTEND_DOUBT_SESSION',
        title: `Ask about ${topic.topicName}`,
        reason: `You are at ${Math.round(state.score)}% here after ${state.attempts} attempts. This one is worth talking through with your teacher rather than grinding alone.`,
        priority: 10,
      });
      continue;
    }

    if (state.score < 50) {
      out.push({
        topicId: topic.topicId,
        kind: 'WATCH_MATERIAL',
        title: `Revisit the notes on ${topic.topicName}`,
        reason: `Your score here is ${Math.round(state.score)}%. Going back over the material usually shifts this faster than more questions.`,
        priority: 20,
      });
      continue;
    }

    if (state.score < 70) {
      out.push({
        topicId: topic.topicId,
        kind: 'PRACTICE_MORE',
        title: `More practice on ${topic.topicName}`,
        reason: `You are at ${Math.round(state.score)}% and close to solid. A few more questions should do it.`,
        priority: 40,
      });
      continue;
    }

    // Strong but stale: revision beats new ground.
    if (topic.daysSinceAssessed !== null && topic.daysSinceAssessed > 21) {
      out.push({
        topicId: topic.topicId,
        kind: 'REVISE_TOPIC',
        title: `Quick revision of ${topic.topicName}`,
        reason: `You were strong here, but it has been ${topic.daysSinceAssessed} days.`,
        priority: 50,
      });
      continue;
    }

    if (state.level === 'MASTERED') {
      out.push({
        topicId: topic.topicId,
        kind: 'ATTEMPT_VIVA',
        title: `Take a viva on ${topic.topicName}`,
        reason: 'You have mastered the written work here. A viva will test whether you can explain it.',
        priority: 60,
      });
    }
  }

  // Fast and wrong is a different problem from slow and wrong, and it deserves
  // its own nudge rather than being lumped in with weakness.
  const rushing = topics.filter(
    (t) =>
      t.state.attempts >= 5 &&
      t.state.score < 50 &&
      t.state.avgTimeSec !== null &&
      t.state.avgTimeSec < 25,
  );

  if (rushing.length >= 2) {
    out.push({
      topicId: null,
      kind: 'SLOW_DOWN',
      title: 'Try slowing down',
      reason: `You are averaging under 25 seconds a question across ${rushing.length} topics you are struggling with. Reading the question twice is likely worth more than extra practice.`,
      priority: 15,
    });
  }

  return out.sort((a, b) => a.priority - b.priority).slice(0, maxItems);
}

export interface SubjectRollup {
  masteryScore: number;
  masteryLevel: MasteryLevel;
  preferredDifficulty: Difficulty;
  strongTopics: { topicId: string; score: number }[];
  weakTopics: { topicId: string; score: number }[];
}

/**
 * Rolls topic mastery up to a subject.
 *
 * Weighted by attempts, so a topic the student has actually worked at counts
 * more than one they touched once. An unweighted mean would let a single lucky
 * answer on a minor topic lift a whole subject.
 */
export function rollUpSubject(topics: TopicSnapshot[]): SubjectRollup {
  const assessed = topics.filter((t) => t.state.attempts > 0);

  if (assessed.length === 0) {
    return {
      masteryScore: 0,
      masteryLevel: 'BEGINNER',
      preferredDifficulty: 'EASY',
      strongTopics: [],
      weakTopics: [],
    };
  }

  const totalAttempts = assessed.reduce((sum, t) => sum + t.state.attempts, 0);
  const weighted = assessed.reduce((sum, t) => sum + t.state.score * t.state.attempts, 0);
  const masteryScore = round(weighted / totalAttempts);

  const ranked = [...assessed].sort((a, b) => b.state.score - a.state.score);

  return {
    masteryScore,
    masteryLevel: levelFor(masteryScore, totalAttempts),
    preferredDifficulty: recommendDifficulty({
      ...INITIAL_MASTERY,
      score: masteryScore,
      attempts: totalAttempts,
    }),
    strongTopics: ranked
      .filter((t) => t.state.score >= 70)
      .slice(0, 5)
      .map((t) => ({ topicId: t.topicId, score: t.state.score })),
    weakTopics: ranked
      .filter((t) => t.state.score < 50)
      .reverse()
      .slice(0, 5)
      .map((t) => ({ topicId: t.topicId, score: t.state.score })),
  };
}
