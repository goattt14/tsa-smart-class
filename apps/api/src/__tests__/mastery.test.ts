import { describe, expect, it } from 'vitest';
import {
  applyOutcome,
  applyOutcomes,
  buildRecommendations,
  INITIAL_MASTERY,
  levelFor,
  recommendDifficulty,
  rollUpSubject,
  type AttemptOutcome,
  type TopicSnapshot,
} from '../modules/performance/mastery';

const right = (difficulty: AttemptOutcome['difficulty'] = 'MEDIUM'): AttemptOutcome => ({
  isCorrect: true,
  difficulty,
});

const wrong = (difficulty: AttemptOutcome['difficulty'] = 'MEDIUM'): AttemptOutcome => ({
  isCorrect: false,
  difficulty,
});

describe('mastery levels demand evidence, not just a score', () => {
  it('does not award a level on one lucky answer', () => {
    expect(levelFor(95, 1)).toBe('BEGINNER');
  });

  it('unlocks developing at two attempts', () => {
    expect(levelFor(95, 2)).toBe('DEVELOPING');
  });

  it('requires twelve attempts for mastered', () => {
    expect(levelFor(90, 11)).toBe('STRONG');
    expect(levelFor(90, 12)).toBe('MASTERED');
  });
});

describe('score progression', () => {
  it('moves decisively on the first answer', () => {
    expect(applyOutcome(INITIAL_MASTERY, right()).score).toBe(35);
  });

  it('builds a real score over a run of correct answers', () => {
    expect(applyOutcomes(INITIAL_MASTERY, Array(5).fill(right())).score).toBeGreaterThan(80);
  });

  it('weights a hard success above an easy one', () => {
    const hard = applyOutcome(INITIAL_MASTERY, right('VERY_HARD')).score;
    const easy = applyOutcome(INITIAL_MASTERY, right('VERY_EASY')).score;
    expect(hard).toBeGreaterThan(easy);
  });

  it('moves less as evidence accumulates', () => {
    const early = applyOutcome({ ...INITIAL_MASTERY, score: 50, attempts: 1 }, right()).score - 50;
    const late = applyOutcome({ ...INITIAL_MASTERY, score: 50, attempts: 30 }, right()).score - 50;
    expect(late).toBeLessThan(early);
  });

  it('stays inside 0 to 100 under sustained success or failure', () => {
    expect(applyOutcomes(INITIAL_MASTERY, Array(40).fill(right('VERY_HARD'))).score).toBeLessThanOrEqual(100);
    expect(applyOutcomes({ ...INITIAL_MASTERY, score: 60, attempts: 20 }, Array(40).fill(wrong())).score).toBeGreaterThanOrEqual(0);
  });

  it('tracks and resets the streak', () => {
    const streak = applyOutcomes(INITIAL_MASTERY, Array(5).fill(right()));
    expect(streak.consecutiveRight).toBe(5);
    expect(applyOutcome(streak, wrong()).consecutiveRight).toBe(0);
  });

  it('honours partial credit on a written answer', () => {
    expect(applyOutcome(INITIAL_MASTERY, { isCorrect: false, creditFraction: 0.5, difficulty: 'MEDIUM' }).score).toBe(17.5);
  });

  it('averages response time', () => {
    const state = applyOutcomes(INITIAL_MASTERY, [
      { isCorrect: true, difficulty: 'MEDIUM', timeTakenSec: 60 },
      { isCorrect: true, difficulty: 'MEDIUM', timeTakenSec: 40 },
    ]);
    expect(state.avgTimeSec).toBe(50);
  });
});

describe('adaptive difficulty', () => {
  it('starts a beginner gently', () => {
    expect(recommendDifficulty(INITIAL_MASTERY)).toBe('VERY_EASY');
  });

  it('stretches a student on a streak', () => {
    expect(recommendDifficulty({ ...INITIAL_MASTERY, score: 75 })).toBe('HARD');
    expect(recommendDifficulty({ ...INITIAL_MASTERY, score: 75, consecutiveRight: 3 })).toBe('VERY_HARD');
  });

  it('cannot exceed the top band', () => {
    expect(recommendDifficulty({ ...INITIAL_MASTERY, score: 100, consecutiveRight: 20 })).toBe('VERY_HARD');
  });
});

describe('recommendations', () => {
  const snap = (
    topicId: string,
    topicName: string,
    score: number,
    attempts: number,
    extra: Partial<TopicSnapshot> = {},
  ): TopicSnapshot => ({
    topicId,
    topicName,
    taughtInClass: true,
    daysSinceAssessed: 1,
    state: { ...INITIAL_MASTERY, score, attempts, level: levelFor(score, attempts) },
    ...extra,
  });

  it('caps the list so a dashboard stays actionable', () => {
    const recs = buildRecommendations([
      snap('t1', 'Kinematics', 20, 6),
      snap('t2', 'Optics', 45, 5),
      snap('t3', 'Thermodynamics', 65, 6),
      snap('t4', 'Waves', 0, 0),
      snap('t5', 'Untaught', 0, 0, { taughtInClass: false }),
    ]);

    expect(recs).toHaveLength(4);
    expect(recs[0]).toMatchObject({ topicId: 't1', kind: 'ATTEND_DOUBT_SESSION' });
    expect(recs.some((r) => r.topicId === 't5')).toBe(false);
    expect(recs.some((r) => r.topicId === 't4')).toBe(true);
  });

  it('offers a viva once a topic is mastered', () => {
    expect(buildRecommendations([snap('t9', 'Algebra', 90, 14)])[0]?.kind).toBe('ATTEMPT_VIVA');
  });

  it('suggests revision when a strong topic goes stale', () => {
    const recs = buildRecommendations([snap('t8', 'Calculus', 80, 10, { daysSinceAssessed: 40 })]);
    expect(recs[0]?.kind).toBe('REVISE_TOPIC');
  });

  it('calls out rushing as its own problem', () => {
    const recs = buildRecommendations([
      snap('r1', 'A', 35, 8, { state: { ...INITIAL_MASTERY, score: 35, attempts: 8, avgTimeSec: 12 } }),
      snap('r2', 'B', 40, 9, { state: { ...INITIAL_MASTERY, score: 40, attempts: 9, avgTimeSec: 15 } }),
    ]);
    expect(recs.some((r) => r.kind === 'SLOW_DOWN')).toBe(true);
  });

  it('says nothing when there is nothing to say', () => {
    expect(buildRecommendations([snap('ok', 'Fine', 80, 10)])).toEqual([]);
  });
});

describe('subject rollup', () => {
  const snap = (topicId: string, score: number, attempts: number): TopicSnapshot => ({
    topicId,
    topicName: topicId,
    taughtInClass: true,
    daysSinceAssessed: 1,
    state: { ...INITIAL_MASTERY, score, attempts, level: levelFor(score, attempts) },
  });

  it('weights by attempts rather than taking a flat mean', () => {
    // A flat mean of 40 and 95 would read 67.5; weighting by evidence should
    // stay much closer to the topic actually worked at.
    expect(rollUpSubject([snap('heavy', 40, 20), snap('light', 95, 2)]).masteryScore).toBeLessThan(55);
  });

  it('lists weak topics', () => {
    expect(rollUpSubject([snap('weak', 40, 20), snap('strong', 95, 20)]).weakTopics.map((t) => t.topicId)).toEqual(['weak']);
  });

  it('reads an unassessed subject as beginner', () => {
    expect(rollUpSubject([snap('none', 0, 0)]).masteryLevel).toBe('BEGINNER');
  });
});
