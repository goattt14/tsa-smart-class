/**
 * The grading engine.
 *
 * Pure functions, no database and no AI call. Everything a machine can mark
 * objectively is marked here; everything that needs judgement is flagged for a
 * human or for the Phase 4 evaluator rather than guessed at.
 *
 * The distinction matters more than it looks. Silently awarding zero to a
 * long-answer question because no automatic rule matched would tell a student
 * they were wrong when nobody has actually read their work.
 */

export type QuestionType =
  | 'MCQ_SINGLE'
  | 'MCQ_MULTI'
  | 'TRUE_FALSE'
  | 'FILL_BLANK'
  | 'SHORT_ANSWER'
  | 'LONG_ANSWER'
  | 'NUMERICAL'
  | 'VIVA_ORAL';

export interface GradableQuestion {
  id: string;
  type: QuestionType;
  marks: number;
  /** MCQ option id, array of ids, accepted strings, or a number. */
  correctAnswer: unknown;
  /**
   * NUMERICAL only. Absolute tolerance, or a percentage when
   * toleranceIsRelative is set. Defaults to exact equality.
   */
  tolerance?: number;
  toleranceIsRelative?: boolean;
}

export interface SubmittedAnswer {
  responseText?: string | null;
  /** MCQ selections: a single option id or an array of them. */
  selectedOption?: unknown;
}

export interface GradingOptions {
  /** Marks removed for a wrong MCQ answer, as a fraction of the question's marks. */
  negativeMarkingFraction: number;
  /** Whether MCQ_MULTI awards proportional credit or is all-or-nothing. */
  allowPartialCredit: boolean;
}

export const DEFAULT_GRADING: GradingOptions = {
  negativeMarkingFraction: 0,
  allowPartialCredit: true,
};

export interface GradeResult {
  questionId: string;
  /** null when no machine verdict is possible. */
  isCorrect: boolean | null;
  /** null when the question still needs a human or the AI evaluator. */
  marksAwarded: number | null;
  needsManualReview: boolean;
  /** Shown to the teacher reviewing the paper, never to the student as-is. */
  note: string;
}

/**
 * Normalises free text before comparison: case, surrounding space, repeated
 * space, and trailing punctuation. Deliberately conservative — it does not
 * stem or spell-correct, because "there" and "their" are different answers.
 */
export function normaliseText(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      // Whitespace is collapsed and trimmed *before* punctuation is stripped.
      // The other order leaves the full stop on "mitochondria. " because the
      // string does not end in punctuation while the trailing space is there,
      // and a student who typed a trailing space would be marked wrong.
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.,;:!?]+$/g, '')
      .trim()
  );
}

/** Pulls a number out of a response, tolerating units and thousands separators. */
export function parseNumeric(value: string): number | null {
  const cleaned = value.replace(/,/g, '').trim();
  const match = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(cleaned);
  if (!match) return null;

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value === null || value === undefined) return [];
  return [String(value)];
}

function round(value: number): number {
  // Two decimals: enough for half-marks and quarter-marks, and it stops
  // floating-point noise turning 7.5 into 7.499999999999999 on a marksheet.
  const rounded = Math.round(value * 100) / 100;
  // Avoid -0 which breaks Object.is equality in tests and looks wrong on reports
  return rounded === 0 ? 0 : rounded;
}

function isBlank(answer: SubmittedAnswer): boolean {
  const text = answer.responseText?.trim() ?? '';
  const selected = toStringArray(answer.selectedOption);
  return text.length === 0 && selected.length === 0;
}

/** Marks one answer. */
export function gradeAnswer(
  question: GradableQuestion,
  answer: SubmittedAnswer,
  options: GradingOptions = DEFAULT_GRADING,
): GradeResult {
  const base = { questionId: question.id };

  // An unanswered question scores zero regardless of type, and never attracts
  // a negative mark: not attempting is not the same as guessing wrong.
  if (isBlank(answer)) {
    return {
      ...base,
      isCorrect: false,
      marksAwarded: 0,
      needsManualReview: false,
      note: 'No answer given.',
    };
  }

  switch (question.type) {
    case 'MCQ_SINGLE':
    case 'TRUE_FALSE': {
      const expected = toStringArray(question.correctAnswer).map(normaliseText);
      const givenRaw = toStringArray(answer.selectedOption);
      const given = (
        givenRaw.length > 0 ? givenRaw : [answer.responseText ?? '']
      ).map(normaliseText);

      if (given.length > 1) {
        return {
          ...base,
          isCorrect: false,
          marksAwarded: 0,
          needsManualReview: false,
          note: 'More than one option selected on a single-answer question.',
        };
      }

      const correct = expected.includes(given[0] ?? '');

      return {
        ...base,
        isCorrect: correct,
        marksAwarded: correct
          ? round(question.marks)
          : round(-question.marks * options.negativeMarkingFraction),
        needsManualReview: false,
        note: correct ? 'Correct option.' : 'Wrong option.',
      };
    }

    case 'MCQ_MULTI': {
      const expected = new Set(toStringArray(question.correctAnswer).map(normaliseText));
      const given = new Set(toStringArray(answer.selectedOption).map(normaliseText));

      if (expected.size === 0) {
        return {
          ...base,
          isCorrect: null,
          marksAwarded: null,
          needsManualReview: true,
          note: 'This question has no correct answer recorded.',
        };
      }

      let hits = 0;
      let misses = 0;
      for (const choice of given) {
        if (expected.has(choice)) hits += 1;
        else misses += 1;
      }

      const exact = hits === expected.size && misses === 0;

      if (!options.allowPartialCredit) {
        return {
          ...base,
          isCorrect: exact,
          marksAwarded: exact
            ? round(question.marks)
            : round(-question.marks * options.negativeMarkingFraction),
          needsManualReview: false,
          note: exact ? 'All correct options selected.' : 'Selection did not match exactly.',
        };
      }

      // Any wrong tick voids the question. Proportional credit alone would let a
      // student tick every option and collect a share of the marks for knowing
      // nothing, so partial credit is only available to an answer that is
      // incomplete rather than incorrect. This mirrors how multi-correct
      // questions are marked in Indian board and entrance papers.
      if (misses > 0) {
        return {
          ...base,
          isCorrect: false,
          marksAwarded: round(-question.marks * options.negativeMarkingFraction),
          needsManualReview: false,
          note: `${misses} incorrect option(s) selected, so no credit is given.`,
        };
      }

      return {
        ...base,
        isCorrect: exact,
        marksAwarded: round(question.marks * (hits / expected.size)),
        needsManualReview: false,
        note: exact
          ? 'All correct options selected.'
          : `${hits} of ${expected.size} correct options selected, none incorrect.`,
      };
    }

    case 'FILL_BLANK': {
      const accepted = toStringArray(question.correctAnswer).map(normaliseText);
      const given = normaliseText(answer.responseText ?? '');

      if (accepted.length === 0) {
        return {
          ...base,
          isCorrect: null,
          marksAwarded: null,
          needsManualReview: true,
          note: 'No accepted answers recorded for this blank.',
        };
      }

      const correct = accepted.includes(given);

      return {
        ...base,
        isCorrect: correct,
        marksAwarded: correct ? round(question.marks) : 0,
        needsManualReview: false,
        note: correct ? 'Matches an accepted answer.' : 'Does not match any accepted answer.',
      };
    }

    case 'NUMERICAL': {
      const given = parseNumeric(answer.responseText ?? '');
      const expected =
        typeof question.correctAnswer === 'number'
          ? question.correctAnswer
          : parseNumeric(String(question.correctAnswer ?? ''));

      if (expected === null) {
        return {
          ...base,
          isCorrect: null,
          marksAwarded: null,
          needsManualReview: true,
          note: 'The recorded answer is not a number.',
        };
      }

      if (given === null) {
        return {
          ...base,
          isCorrect: false,
          marksAwarded: 0,
          needsManualReview: false,
          note: 'No number could be read from the response.',
        };
      }

      const tolerance = question.tolerance ?? 0;
      const allowed = question.toleranceIsRelative
        ? Math.abs(expected) * (tolerance / 100)
        : tolerance;

      const correct = Math.abs(given - expected) <= allowed;

      return {
        ...base,
        isCorrect: correct,
        marksAwarded: correct ? round(question.marks) : 0,
        needsManualReview: false,
        note: correct
          ? 'Within tolerance.'
          : `Expected ${expected}${allowed > 0 ? ` ± ${round(allowed)}` : ''}, received ${given}.`,
      };
    }

    case 'SHORT_ANSWER':
    case 'LONG_ANSWER':
    case 'VIVA_ORAL':
      // Deliberately unmarked. Phase 4's evaluator or the teacher decides, and
      // until then the mark is absent rather than zero.
      return {
        ...base,
        isCorrect: null,
        marksAwarded: null,
        needsManualReview: true,
        note: 'Written response awaiting evaluation.',
      };

    default:
      return {
        ...base,
        isCorrect: null,
        marksAwarded: null,
        needsManualReview: true,
        note: 'Unrecognised question type.',
      };
  }
}

export interface AttemptScore {
  /** Marks confirmed so far. Excludes anything still awaiting evaluation. */
  score: number;
  maxMarks: number;
  /** Marks locked up in unevaluated questions. */
  pendingMarks: number;
  percentage: number;
  isPassed: boolean | null;
  autoGraded: number;
  awaitingReview: number;
  /** True while any answer is unevaluated, so the UI can say "provisional". */
  isProvisional: boolean;
}

/**
 * Totals an attempt.
 *
 * Pass/fail returns null while anything is unmarked, because telling a student
 * they failed before their written answers have been read would be both wrong
 * and cruel. The percentage is computed against the marks actually decided, so
 * a provisional figure is a fair reading of the work marked so far.
 */
export function scoreAttempt(
  results: GradeResult[],
  questions: GradableQuestion[],
  passingMarks: number,
): AttemptScore {
  const marksById = new Map(questions.map((q) => [q.id, q.marks]));

  let score = 0;
  let pendingMarks = 0;
  let autoGraded = 0;
  let awaitingReview = 0;

  for (const result of results) {
    const questionMarks = marksById.get(result.questionId) ?? 0;

    if (result.marksAwarded === null) {
      pendingMarks += questionMarks;
      awaitingReview += 1;
      continue;
    }

    score += result.marksAwarded;
    autoGraded += 1;
  }

  const maxMarks = questions.reduce((sum, q) => sum + q.marks, 0);
  const decided = maxMarks - pendingMarks;

  // Negative marking can push a total below zero; a negative percentage on a
  // report card helps nobody.
  score = round(Math.max(0, score));

  return {
    score,
    maxMarks: round(maxMarks),
    pendingMarks: round(pendingMarks),
    percentage: decided > 0 ? round((score / decided) * 100) : 0,
    isPassed: awaitingReview > 0 ? null : score >= passingMarks,
    autoGraded,
    awaitingReview,
    isProvisional: awaitingReview > 0,
  };
}

/**
 * Standard competitive ranking: equal scores share a rank and the next rank
 * skips accordingly, so two students on 45 are both 1st and the next is 3rd.
 */
export function rankAttempts(
  attempts: { attemptId: string; score: number }[],
): { attemptId: string; score: number; rank: number }[] {
  const sorted = [...attempts].sort((a, b) => b.score - a.score);

  const ranked: { attemptId: string; score: number; rank: number }[] = [];
  let lastScore: number | null = null;
  let lastRank = 0;

  sorted.forEach((attempt, index) => {
    const rank = lastScore !== null && attempt.score === lastScore ? lastRank : index + 1;
    ranked.push({ ...attempt, rank });
    lastScore = attempt.score;
    lastRank = rank;
  });

  return ranked;
}
