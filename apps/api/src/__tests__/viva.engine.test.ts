import { describe, expect, it } from 'vitest';
import {
  applyAnswer,
  decideNext,
  describeOutcome,
  DEFAULT_VIVA_POLICY,
  INITIAL_VIVA_STATE,
  scoreViva,
  type AnswerOutcome,
  type VivaState,
} from '../modules/viva/viva.engine';

const answer = (creditFraction: number, extra: Partial<AnswerOutcome> = {}): AnswerOutcome => ({
  creditFraction,
  difficulty: 'MEDIUM',
  wasSilent: false,
  wasUnintelligible: false,
  wasShallow: false,
  isFollowUp: false,
  followUpDepth: 0,
  ...extra,
});

const state = (extra: Partial<VivaState> = {}): VivaState => ({ ...INITIAL_VIVA_STATE, ...extra });
const signals = { totalWords: 200, avgSttConfidence: 0.9, speakingSec: 300 };

describe('difficulty adaptation', () => {
  it('opens at the configured level', () => {
    const next = decideNext(state());
    expect(next.kind).toBe('ASK');
    expect(next.kind === 'ASK' && next.difficulty).toBe('MEDIUM');
  });

  it.each([
    [0.9, 'HARD', 'steps up after a strong answer'],
    [0.5, 'MEDIUM', 'holds after a partial answer'],
    [0.1, 'EASY', 'steps down after a weak answer'],
  ])('credit %s leads to %s', (credit, expected) => {
    const next = decideNext(state({ askedCount: 1, elapsedSec: 60, outcomes: [answer(credit)] }));
    expect(next.kind === 'ASK' && next.difficulty).toBe(expected);
  });

  it('cannot step below the bottom of the ladder', () => {
    const next = decideNext(state({ askedCount: 2, elapsedSec: 120, currentDifficulty: 'VERY_EASY', outcomes: [answer(0.1), answer(0.1)] }));
    expect(next.kind === 'ASK' && next.difficulty).toBe('VERY_EASY');
  });

  it('cannot step above the top of the ladder', () => {
    const next = decideNext(state({ askedCount: 1, elapsedSec: 60, currentDifficulty: 'VERY_HARD', outcomes: [answer(0.95)] }));
    expect(next.kind === 'ASK' && next.difficulty).toBe('VERY_HARD');
  });
});

describe('probing', () => {
  it('probes a correct but thin answer', () => {
    const next = decideNext(state({ askedCount: 1, elapsedSec: 60, outcomes: [answer(0.85, { wasShallow: true })] }));
    expect(next.kind).toBe('PROBE');
  });

  it('never probes a wrong answer', () => {
    const next = decideNext(state({ askedCount: 1, elapsedSec: 60, outcomes: [answer(0.2, { wasShallow: true })] }));
    expect(next.kind).toBe('ASK');
  });

  it('stops probing at the depth limit', () => {
    const next = decideNext(state({ askedCount: 3, elapsedSec: 180, outcomes: [answer(0.85, { wasShallow: true, followUpDepth: 2 })] }));
    expect(next.kind).toBe('ASK');
  });
});

describe('ending the session', () => {
  it.each([
    [{ askedCount: 12, elapsedSec: 300 }, 'QUESTION_LIMIT'],
    [{ askedCount: 5, elapsedSec: 900 }, 'TIME_UP'],
    [{ askedCount: 6, elapsedSec: 880 }, 'NO_TIME_FOR_ANOTHER'],
  ])('ends with %o', (partial, reason) => {
    const next = decideNext(state({ ...partial, outcomes: [answer(0.8)] }));
    expect(next.kind === 'END' && next.reason).toBe(reason);
  });

  it('keeps going below the minimum even when time is short', () => {
    expect(decideNext(state({ askedCount: 2, elapsedSec: 880, outcomes: [answer(0.8)] })).kind).toBe('ASK');
  });

  it('stops when the student has gone quiet', () => {
    const next = decideNext(state({ askedCount: 5, elapsedSec: 300, outcomes: [answer(0, { wasSilent: true }), answer(0, { wasSilent: true })] }));
    expect(next.kind === 'END' && next.reason).toBe('STUDENT_DISENGAGED');
  });

  it('does not give up on silence before the minimum', () => {
    expect(decideNext(state({ askedCount: 2, elapsedSec: 120, outcomes: [answer(0, { wasSilent: true }), answer(0, { wasSilent: true })] })).kind).toBe('ASK');
  });
});

describe('state folding', () => {
  it('records the answer and carries the new difficulty', () => {
    const next = applyAnswer(state(), answer(0.8), 70, 'HARD');
    expect(next).toMatchObject({ askedCount: 1, currentDifficulty: 'HARD' });
    expect(next.outcomes).toHaveLength(1);
  });
});

describe('scoring', () => {
  const good = scoreViva([answer(1, { difficulty: 'HARD' }), answer(0.9), answer(0.8), answer(1, { difficulty: 'EASY' })], signals);

  it('keeps conceptual and communication apart', () => {
    expect(good.conceptualScore).not.toBe(good.communicationScore);
  });

  it('weights conceptual understanding at four fifths', () => {
    const expected = good.conceptualScore * 0.8 + good.communicationScore * 0.2;
    expect(Math.abs(good.overallScore - expected)).toBeLessThan(0.2);
  });

  it('rewards a hard question more than an easy one', () => {
    const hard = scoreViva([answer(1, { difficulty: 'VERY_HARD' })], signals).conceptualScore;
    const easy = scoreViva([answer(1, { difficulty: 'VERY_EASY' })], signals).conceptualScore;
    expect(hard).toBe(easy);
  });

  it('excludes silent answers rather than scoring them zero', () => {
    const score = scoreViva([answer(1), answer(1), answer(1), answer(1), answer(0, { wasSilent: true })], signals);
    expect(score.conceptualScore).toBe(100);
    expect(score.silent).toBe(1);
  });

  it('reports an empty session as inconclusive, not as a zero', () => {
    expect(scoreViva([answer(0, { wasSilent: true })], signals).isInconclusive).toBe(true);
  });

  it('needs the minimum number of answers to be conclusive', () => {
    expect(scoreViva([answer(0.9), answer(0.9)], signals).isInconclusive).toBe(true);
    expect(scoreViva([answer(0.9), answer(0.9), answer(0.8), answer(0.7)], signals).isInconclusive).toBe(false);
  });

  it('does not let short speech drag down the conceptual score', () => {
    const terse = scoreViva([answer(1), answer(1), answer(1), answer(1)], { totalWords: 10, avgSttConfidence: 0.9, speakingSec: 20 });
    expect(terse.conceptualScore).toBe(100);
    expect(terse.communicationScore).toBeLessThan(100);
  });

  it('tracks the hardest question actually cleared', () => {
    const score = scoreViva([answer(0.9, { difficulty: 'HARD' }), answer(0.2, { difficulty: 'VERY_HARD' })], signals);
    expect(score.highestDifficultyCleared).toBe('HARD');
  });
});

describe('plain-language outcome', () => {
  it('says plainly when there is nothing to report', () => {
    expect(describeOutcome(scoreViva([], signals))).toContain('nothing to report');
  });
});
