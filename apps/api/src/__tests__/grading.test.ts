import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRADING,
  gradeAnswer,
  normaliseText,
  parseNumeric,
  rankAttempts,
  scoreAttempt,
  type GradableQuestion,
} from '../modules/tests/grading';

const q = (o: Partial<GradableQuestion> = {}): GradableQuestion => ({
  id: 'q1',
  type: 'MCQ_SINGLE',
  marks: 4,
  correctAnswer: 'b',
  ...o,
});

describe('single-answer multiple choice', () => {
  it('awards full marks for the right option', () => {
    expect(gradeAnswer(q(), { selectedOption: 'b' }).marksAwarded).toBe(4);
  });

  it('awards nothing for the wrong option by default', () => {
    expect(gradeAnswer(q(), { selectedOption: 'a' }).marksAwarded).toBe(0);
  });

  it('applies negative marking when configured', () => {
    const result = gradeAnswer(q(), { selectedOption: 'a' }, { ...DEFAULT_GRADING, negativeMarkingFraction: 0.25 });
    expect(result.marksAwarded).toBe(-1);
  });

  it('never penalises a blank answer', () => {
    const result = gradeAnswer(q(), {}, { ...DEFAULT_GRADING, negativeMarkingFraction: 0.25 });
    expect(result.marksAwarded).toBe(0);
  });

  it('rejects two selections on a single-answer question', () => {
    expect(gradeAnswer(q(), { selectedOption: ['a', 'b'] }).marksAwarded).toBe(0);
  });

  it('matches option ids case-insensitively', () => {
    expect(gradeAnswer(q(), { selectedOption: 'B' }).isCorrect).toBe(true);
  });
});

describe('multi-answer multiple choice', () => {
  const multi = q({ type: 'MCQ_MULTI', correctAnswer: ['a', 'c', 'd'], marks: 6 });

  it('awards full marks for an exact selection', () => {
    expect(gradeAnswer(multi, { selectedOption: ['a', 'c', 'd'] }).marksAwarded).toBe(6);
  });

  it('gives proportional credit for an incomplete but correct selection', () => {
    expect(gradeAnswer(multi, { selectedOption: ['a', 'c'] }).marksAwarded).toBe(4);
  });

  it('voids the question when any wrong option is ticked', () => {
    expect(gradeAnswer(multi, { selectedOption: ['a', 'c', 'b'] }).marksAwarded).toBe(0);
  });

  it('gives nothing for ticking every option', () => {
    expect(gradeAnswer(multi, { selectedOption: ['a', 'b', 'c', 'd', 'e'] }).marksAwarded).toBe(0);
  });

  it('can penalise a wrong tick', () => {
    const result = gradeAnswer(multi, { selectedOption: ['a', 'b'] }, { ...DEFAULT_GRADING, negativeMarkingFraction: 0.5 });
    expect(result.marksAwarded).toBe(-3);
  });

  it('gives nothing for a partial selection in all-or-nothing mode', () => {
    const result = gradeAnswer(multi, { selectedOption: ['a', 'c'] }, { ...DEFAULT_GRADING, allowPartialCredit: false });
    expect(result.marksAwarded).toBe(0);
  });
});

describe('fill in the blank', () => {
  const blank = q({ type: 'FILL_BLANK', correctAnswer: ['mitochondria', 'the mitochondria'], marks: 2 });

  it.each([
    ['mitochondria'],
    ['The Mitochondria'],
    ['mitochondria.'],
    ['mitochondria. '],
    ['Mitochondria.\n'],
    ['  the   mitochondria '],
  ])('accepts %j', (given) => {
    expect(gradeAnswer(blank, { responseText: given }).marksAwarded).toBe(2);
  });

  it('rejects a different word', () => {
    expect(gradeAnswer(blank, { responseText: 'ribosome' }).marksAwarded).toBe(0);
  });

  it('does not accept a near miss', () => {
    expect(gradeAnswer(blank, { responseText: 'mitochondrion' }).isCorrect).toBe(false);
  });
});

describe('numerical answers', () => {
  it.each([
    ['9.8', 9.8, undefined, false, true],
    ['9.8 m/s2', 9.8, undefined, false, true],
    ['1,500', 1500, undefined, false, true],
    ['3e-10', 0.0000000003, 1e-11, false, true],
    ['9.65', 9.8, 0.2, false, true],
    ['9.5', 9.8, 0.2, false, false],
    ['208', 200, 5, true, true],
    ['215', 200, 5, true, false],
  ])('grades %s against %s', (given, expected, tolerance, relative, shouldPass) => {
    const question = q({
      type: 'NUMERICAL',
      correctAnswer: expected,
      marks: 3,
      ...(tolerance !== undefined ? { tolerance } : {}),
      ...(relative ? { toleranceIsRelative: true } : {}),
    });
    expect(gradeAnswer(question, { responseText: given }).isCorrect).toBe(shouldPass);
  });

  it('scores zero when no number can be read', () => {
    expect(gradeAnswer(q({ type: 'NUMERICAL', correctAnswer: 9.8, marks: 3 }), { responseText: 'about ten' }).marksAwarded).toBe(0);
  });
});

describe('written answers are never auto-marked', () => {
  it.each(['SHORT_ANSWER', 'LONG_ANSWER', 'VIVA_ORAL'] as const)('leaves %s for a human', (type) => {
    const result = gradeAnswer(q({ type, marks: 10, correctAnswer: null }), { responseText: 'A considered answer.' });
    expect(result.marksAwarded).toBeNull();
    expect(result.needsManualReview).toBe(true);
  });

  it('still scores an empty written answer as zero', () => {
    expect(gradeAnswer(q({ type: 'LONG_ANSWER', marks: 10 }), { responseText: '   ' }).marksAwarded).toBe(0);
  });
});

describe('misconfigured questions are flagged rather than guessed', () => {
  it('flags a multi-answer question with no answer key', () => {
    expect(gradeAnswer(q({ type: 'MCQ_MULTI', correctAnswer: [], marks: 4 }), { selectedOption: ['a'] }).needsManualReview).toBe(true);
  });

  it('flags a numerical question with a non-numeric key', () => {
    expect(gradeAnswer(q({ type: 'NUMERICAL', correctAnswer: 'ten', marks: 4 }), { responseText: '10' }).needsManualReview).toBe(true);
  });
});

describe('attempt totals', () => {
  const questions: GradableQuestion[] = [
    q({ id: 'a', type: 'MCQ_SINGLE', marks: 4, correctAnswer: 'b' }),
    q({ id: 'b', type: 'NUMERICAL', marks: 6, correctAnswer: 12 }),
    q({ id: 'c', type: 'LONG_ANSWER', marks: 10, correctAnswer: null }),
  ];

  const results = [
    gradeAnswer(questions[0]!, { selectedOption: 'b' }),
    gradeAnswer(questions[1]!, { responseText: '12' }),
    gradeAnswer(questions[2]!, { responseText: 'essay' }),
  ];

  const scored = scoreAttempt(results, questions, 10);

  it('counts only confirmed marks', () => {
    expect(scored.score).toBe(10);
    expect(scored.pendingMarks).toBe(10);
  });

  it('computes the percentage over marks actually decided', () => {
    expect(scored.percentage).toBe(100);
  });

  it('withholds pass or fail while anything is unmarked', () => {
    expect(scored.isPassed).toBeNull();
    expect(scored.isProvisional).toBe(true);
  });

  it('gives a verdict once everything is marked', () => {
    const complete = scoreAttempt([results[0]!, results[1]!], [questions[0]!, questions[1]!], 8);
    expect(complete.isPassed).toBe(true);
    expect(complete.isProvisional).toBe(false);
  });

  it('floors a negatively marked total at zero', () => {
    const wrong = gradeAnswer(questions[0]!, { selectedOption: 'x' }, { ...DEFAULT_GRADING, negativeMarkingFraction: 1 });
    expect(scoreAttempt([wrong], [questions[0]!], 2).score).toBe(0);
  });
});

describe('ranking', () => {
  it('shares a rank on a tie and skips the next', () => {
    const ranked = rankAttempts([
      { attemptId: 'x', score: 45 },
      { attemptId: 'y', score: 45 },
      { attemptId: 'z', score: 40 },
      { attemptId: 'w', score: 50 },
    ]);
    expect(ranked.map((r) => [r.attemptId, r.rank])).toEqual([['w', 1], ['x', 2], ['y', 2], ['z', 4]]);
  });
});

describe('helpers', () => {
  it('normalises case, spacing and trailing punctuation', () => {
    expect(normaliseText('  The   MITOCHONDRIA. ')).toBe('the mitochondria');
  });

  it('normalises curly apostrophes', () => {
    expect(normaliseText('Newton\u2019s')).toBe("newton's");
  });

  it('reads a leading number and ignores units', () => {
    expect(parseNumeric('42 kg')).toBe(42);
  });

  it('returns null for prose', () => {
    expect(parseNumeric('about ten')).toBeNull();
  });
});
