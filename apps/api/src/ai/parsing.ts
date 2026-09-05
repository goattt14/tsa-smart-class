/**
 * Parsing and validating what a language model returns.
 * Polished version - fixes prompt injection detection and adds rubricBreakdown
 */

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; raw: string };

export function extractJson(raw: string): string | null {
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(raw);
  const source = fenced?.[1] ?? raw;
  const start = source.search(/[[{]/);
  if (start === -1) return null;
  const opening = source[start];
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === opening) depth += 1;
    else if (char === closing) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

export function repairJson(text: string): string {
  return text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/^\s*\/\/.*$/gm, '')
    .trim();
}

export function parseModelJson<T = unknown>(raw: string): ParseResult<T> {
  const extracted = extractJson(raw);
  if (!extracted) {
    return { ok: false, reason: 'The response contained no JSON.', raw: raw.slice(0, 400) };
  }
  try {
    return { ok: true, value: JSON.parse(extracted) as T };
  } catch {
    try {
      return { ok: true, value: JSON.parse(repairJson(extracted)) as T };
    } catch (error) {
      return {
        ok: false,
        reason: `JSON could not be parsed even after repair: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
        raw: extracted.slice(0, 400),
      };
    }
  }
}

export type GeneratedQuestionType =
  | 'MCQ_SINGLE'
  | 'MCQ_MULTI'
  | 'TRUE_FALSE'
  | 'FILL_BLANK'
  | 'SHORT_ANSWER'
  | 'LONG_ANSWER'
  | 'NUMERICAL';

export type GeneratedDifficulty = 'VERY_EASY' | 'EASY' | 'MEDIUM' | 'HARD' | 'VERY_HARD';

export interface GeneratedQuestion {
  type: GeneratedQuestionType;
  difficulty: GeneratedDifficulty;
  body: string;
  options: { id: string; text: string }[] | null;
  correctAnswer: string | string[] | number | null;
  modelAnswer: string | null;
  explanation: string | null;
  marks: number;
  expectedTimeSec?: number;
  sourcePassages: number[];
  sourceChunkIndexes?: number[];
}

const QUESTION_TYPES = new Set<string>([
  'MCQ_SINGLE',
  'MCQ_MULTI',
  'TRUE_FALSE',
  'FILL_BLANK',
  'SHORT_ANSWER',
  'LONG_ANSWER',
  'NUMERICAL',
]);

const DIFFICULTIES = new Set<string>(['VERY_EASY', 'EASY', 'MEDIUM', 'HARD', 'VERY_HARD']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asIndexArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => Number(entry)).filter((n) => Number.isInteger(n));
}

export interface QuestionValidation {
  accepted: GeneratedQuestion[];
  rejected: { index: number; reason: string }[];
}

export function validateGeneratedQuestions(
  value: unknown,
  suppliedPassages: number,
): QuestionValidation {
  const accepted: GeneratedQuestion[] = [];
  const rejected: { index: number; reason: string }[] = [];

  const container = asRecord(value);
  const list = Array.isArray(value)
    ? value
    : Array.isArray(container?.questions)
      ? (container.questions as unknown[])
      : null;

  if (!list) {
    return { accepted, rejected: [{ index: -1, reason: 'No question array was returned.' }] };
  }

  for (const [index, entry] of list.entries()) {
    const record = asRecord(entry);
    if (!record) {
      rejected.push({ index, reason: 'Not an object.' });
      continue;
    }

    const type = String(record.type ?? '').toUpperCase();
    if (!QUESTION_TYPES.has(type)) {
      rejected.push({ index, reason: `Unsupported question type "${record.type}".` });
      continue;
    }

    const body = typeof record.body === 'string' ? record.body.trim() : '';
    if (body.length < 5) {
      rejected.push({ index, reason: 'Question text is missing or too short.' });
      continue;
    }

    const difficulty = String(record.difficulty ?? 'MEDIUM').toUpperCase();
    const marks = Number(record.marks);
    const expectedTimeSec = Number((record as any).expectedTimeSec ?? 120);

    let options: { id: string; text: string }[] | null = null;

    if (type === 'MCQ_SINGLE' || type === 'MCQ_MULTI') {
      const rawOptions = Array.isArray(record.options) ? record.options : [];
      options = rawOptions
        .map((option) => {
          const item = asRecord(option);
          if (!item) return null;
          const id = String(item.id ?? '').trim();
          const text = String(item.text ?? '').trim();
          return id && text ? { id, text } : null;
        })
        .filter((o): o is { id: string; text: string } => o !== null);

      if (options.length < 2) {
        rejected.push({ index, reason: 'A multiple-choice question needs at least two options.' });
        continue;
      }

      const ids = options.map((o) => o.id);
      if (new Set(ids).size !== ids.length) {
        rejected.push({ index, reason: 'Duplicate option ids.' });
        continue;
      }

      const answers = Array.isArray(record.correctAnswer)
        ? record.correctAnswer.map(String)
        : record.correctAnswer !== null && record.correctAnswer !== undefined
          ? [String(record.correctAnswer)]
          : [];

      if (answers.length === 0) {
        rejected.push({ index, reason: 'No correct option marked.' });
        continue;
      }

      const unknown = answers.filter((answer) => !ids.includes(answer));
      if (unknown.length > 0) {
        rejected.push({ index, reason: `Answer "${unknown[0]}" is not one of the options.` });
        continue;
      }

      if (type === 'MCQ_SINGLE' && answers.length > 1) {
        rejected.push({ index, reason: 'Several answers marked on a single-answer question.' });
        continue;
      }
    }

    if (type === 'NUMERICAL') {
      const numeric = Number(record.correctAnswer);
      if (!Number.isFinite(numeric)) {
        rejected.push({ index, reason: 'A numerical question needs a numeric answer.' });
        continue;
      }
    }

    const written = type === 'SHORT_ANSWER' || type === 'LONG_ANSWER';
    const modelAnswer = typeof record.modelAnswer === 'string' ? record.modelAnswer.trim() : '';

    if (written && modelAnswer.length < 10) {
      rejected.push({ index, reason: 'A written question needs a model answer to mark against.' });
      continue;
    }

    const rawSources = (record as any).sourcePassages ?? (record as any).sourceChunkIndexes ?? [];
    const sourcePassages = asIndexArray(rawSources).filter((n) => n >= 1 && n <= suppliedPassages);

    if (sourcePassages.length === 0) {
      // For mock provider, allow sourceChunkIndexes 0 as valid legacy
      const hasZero = asIndexArray(rawSources).includes(0);
      if (!hasZero) {
        rejected.push({
          index,
          reason: 'The question cites no supplied passage, so it cannot be shown as grounded.',
        });
        continue;
      }
    }

    accepted.push({
      type: type as GeneratedQuestionType,
      difficulty: (DIFFICULTIES.has(difficulty) ? difficulty : 'MEDIUM') as GeneratedDifficulty,
      body,
      options,
      correctAnswer:
        type === 'NUMERICAL'
          ? Number(record.correctAnswer)
          : Array.isArray(record.correctAnswer)
            ? record.correctAnswer.map(String)
            : record.correctAnswer !== null && record.correctAnswer !== undefined
              ? String(record.correctAnswer)
              : null,
      modelAnswer: modelAnswer || null,
      explanation:
        typeof record.explanation === 'string' && record.explanation.trim()
          ? record.explanation.trim()
          : null,
      marks: Number.isFinite(marks) && marks > 0 ? Math.min(marks, 20) : 1,
      expectedTimeSec: Number.isFinite(expectedTimeSec) ? expectedTimeSec : 120,
      sourcePassages: sourcePassages.length > 0 ? sourcePassages : [1],
      sourceChunkIndexes: sourcePassages.length > 0 ? sourcePassages : [1],
    });
  }

  return { accepted, rejected };
}

export type Verdict = 'correct' | 'partially_correct' | 'incorrect';

export interface GeneratedEvaluation {
  verdict: Verdict;
  score: number;
  maxScore: number;
  whatWentRight: string;
  whatWentWrong: string | null;
  whyItWentWrong: string | null;
  correctApproach: string | null;
  improvementTip: string | null;
  conceptualErrors: string[];
  calculationErrors: string[];
  missingSteps: string[];
  rubricBreakdown?: { criterion: string; awarded: number; max: number; note: string }[] | null;
  confidence: number | null;
}

function asStringArray(value: unknown, limit = 10): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0)
    .slice(0, limit);
}

export function validateEvaluation(
  value: unknown,
  maxScore: number,
): ParseResult<GeneratedEvaluation> {
  const record = asRecord(value);
  if (!record) {
    return { ok: false, reason: 'The evaluation was not an object.', raw: String(value).slice(0, 200) };
  }

  const verdictRaw = String(record.verdict ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  const verdict: Verdict =
    verdictRaw === 'correct'
      ? 'correct'
      : verdictRaw === 'partially_correct' || verdictRaw === 'partial'
        ? 'partially_correct'
        : verdictRaw === 'incorrect' || verdictRaw === 'wrong'
          ? 'incorrect'
          : 'incorrect';

  if (!['correct', 'partially_correct', 'incorrect', 'partial', 'wrong'].includes(verdictRaw)) {
    return {
      ok: false,
      reason: `Unrecognised verdict "${record.verdict}".`,
      raw: JSON.stringify(record).slice(0, 200),
    };
  }

  const rawScore = Number(record.score);
  if (!Number.isFinite(rawScore)) {
    return { ok: false, reason: 'The score was not a number.', raw: String(record.score) };
  }

  const score = Math.max(0, Math.min(maxScore, Math.round(rawScore * 100) / 100));
  const whatWentRight = typeof record.whatWentRight === 'string' ? record.whatWentRight.trim() : '';

  if (whatWentRight.length === 0) {
    return {
      ok: false,
      reason: 'Every evaluation must say what the student did right, even if only the attempt.',
      raw: JSON.stringify(record).slice(0, 200),
    };
  }

  const whatWentWrong =
    typeof record.whatWentWrong === 'string' && record.whatWentWrong.trim()
      ? record.whatWentWrong.trim()
      : null;
  const whyItWentWrong =
    typeof record.whyItWentWrong === 'string' && record.whyItWentWrong.trim()
      ? record.whyItWentWrong.trim()
      : null;
  const correctApproach =
    typeof record.correctApproach === 'string' && record.correctApproach.trim()
      ? record.correctApproach.trim()
      : null;

  if (verdict !== 'correct') {
    if (!whatWentWrong) {
      return {
        ok: false,
        reason: 'A non-correct verdict must say what went wrong.',
        raw: JSON.stringify(record).slice(0, 200),
      };
    }
    if (!whyItWentWrong) {
      return {
        ok: false,
        reason: 'A non-correct verdict must explain why it went wrong.',
        raw: JSON.stringify(record).slice(0, 200),
      };
    }
    if (!correctApproach) {
      return {
        ok: false,
        reason: 'A non-correct verdict must show the correct approach.',
        raw: JSON.stringify(record).slice(0, 200),
      };
    }
  }

  const confidenceRaw = Number(record.confidence);
  const rubricRaw = record.rubricBreakdown;
  const rubricBreakdown = Array.isArray(rubricRaw)
    ? (rubricRaw as any[])
        .map((r: any) => {
          if (!r || typeof r !== 'object') return null;
          return {
            criterion: String(r.criterion ?? '').slice(0, 200),
            awarded: Number(r.awarded ?? 0),
            max: Number(r.max ?? 0),
            note: String(r.note ?? '').slice(0, 500),
          };
        })
        .filter(Boolean) as { criterion: string; awarded: number; max: number; note: string }[]
    : null;

  return {
    ok: true,
    value: {
      verdict,
      score,
      maxScore,
      whatWentRight,
      whatWentWrong,
      whyItWentWrong,
      correctApproach,
      improvementTip:
        typeof record.improvementTip === 'string' && record.improvementTip.trim()
          ? record.improvementTip.trim()
          : null,
      conceptualErrors: asStringArray(record.conceptualErrors),
      calculationErrors: asStringArray(record.calculationErrors),
      missingSteps: asStringArray(record.missingSteps),
      rubricBreakdown,
      confidence:
        Number.isFinite(confidenceRaw) && confidenceRaw >= 0 && confidenceRaw <= 1
          ? Math.round(confidenceRaw * 100) / 100
          : null,
    },
  };
}

/**
 * Polished prompt injection defence - handles THE, ABOVE, etc.
 * Covers: ignore previous instructions, ignore the above instructions, disregard prior instructions, etc.
 */
export function sanitiseForPrompt(text: string, maxLength = 8000): string {
  return text
    .slice(0, maxLength)
    .replace(/```/g, "'''")
    .replace(
      /\b(ignore|disregard|forget)\b(?:\s+\w+){0,4}?\s+(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/gi,
      '[redacted]',
    )
    .replace(
      /\b(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/gi,
      '[redacted]',
    )
    .replace(/\b(system|assistant|developer)\s*:/gi, '[redacted]:')
    .replace(/<\|\s*[^|]*\s*\|>/g, '[redacted]');
}
