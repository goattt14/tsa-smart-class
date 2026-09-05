import { AiFeature, AiProviderName, EvaluationSource, Prisma, Role } from '@prisma/client';
import { parseModelJson, validateEvaluation, type GeneratedEvaluation } from '../../ai/parsing';
import { buildEvaluationPrompt } from '../../ai/prompts';
import { complete } from '../../ai/router';
import { forbidden, notFound, unprocessable } from '../../lib/http-error';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { unpackScheme } from '../questions/questions.service';
import { gradeAnswer, type GradableQuestion, type QuestionType as GradableType } from '../tests/grading';
import type { AuthContext } from '../../types/express';

function providerEnum(name: string): AiProviderName {
  const upper = name.toUpperCase();
  return (Object.values(AiProviderName) as string[]).includes(upper)
    ? (upper as AiProviderName)
    : AiProviderName.MOCK;
}

export type EvaluationTarget =
  | { kind: 'practiceAnswer'; id: string }
  | { kind: 'testAnswer'; id: string }
  | { kind: 'assignmentSubmission'; id: string };

interface EvaluationSubject {
  questionBody: string;
  questionType: string;
  maxScore: number;
  modelAnswer: string | null;
  markingScheme: { step: string; marks: number }[] | null;
  studentAnswer: string;
  subjectName: string;
  gradeLevel: number | null;
  correctAnswer: unknown;
  tolerance?: number | undefined;
  toleranceIsRelative?: boolean | undefined;
}

async function loadSubject(target: EvaluationTarget): Promise<EvaluationSubject> {
  if (target.kind === 'practiceAnswer') {
    const row = await prisma.practiceAnswer.findUnique({
      where: { id: target.id },
      select: {
        responseText: true,
        practiceQuestion: {
          select: {
            marks: true,
            question: {
              select: {
                body: true,
                type: true,
                marks: true,
                modelAnswer: true,
                markingScheme: true,
                correctAnswer: true,
                subject: { select: { name: true } },
              },
            },
            practiceSession: {
              select: { student: { select: { enrollments: { take: 1, select: { batch: { select: { classGroup: { select: { gradeLevel: true } } } } } } } } },
            },
          },
        },
        uploads: { select: { ocrText: true }, orderBy: { pageNumber: 'asc' } },
      },
    });

    if (!row) throw notFound('Practice answer');

    const question = row.practiceQuestion.question;
    const scheme = unpackScheme(question.markingScheme);

    // A handwritten answer arrives as OCR text; pages are joined in order so
    // the model sees the working as a whole rather than page by page.
    const written =
      row.responseText ??
      row.uploads.map((u) => u.ocrText ?? '').filter(Boolean).join('\n\n');

    return {
      questionBody: question.body,
      questionType: question.type,
      maxScore: row.practiceQuestion.marks || question.marks,
      modelAnswer: question.modelAnswer,
      markingScheme: scheme.steps ?? null,
      studentAnswer: written,
      subjectName: question.subject.name,
      gradeLevel:
        row.practiceQuestion.practiceSession.student.enrollments[0]?.batch.classGroup.gradeLevel ??
        null,
      correctAnswer: question.correctAnswer,
      tolerance: scheme.tolerance,
      toleranceIsRelative: scheme.toleranceIsRelative,
    };
  }

  if (target.kind === 'testAnswer') {
    const row = await prisma.testAnswer.findUnique({
      where: { id: target.id },
      select: {
        responseText: true,
        testQuestion: {
          select: {
            marks: true,
            question: {
              select: {
                body: true,
                type: true,
                marks: true,
                modelAnswer: true,
                markingScheme: true,
                correctAnswer: true,
                subject: { select: { name: true } },
              },
            },
            test: { select: { batch: { select: { classGroup: { select: { gradeLevel: true } } } } } },
          },
        },
      },
    });

    if (!row) throw notFound('Test answer');

    const question = row.testQuestion.question;
    const scheme = unpackScheme(question.markingScheme);

    return {
      questionBody: question.body,
      questionType: question.type,
      maxScore: row.testQuestion.marks || question.marks,
      modelAnswer: question.modelAnswer,
      markingScheme: scheme.steps ?? null,
      studentAnswer: row.responseText ?? '',
      subjectName: question.subject.name,
      gradeLevel: row.testQuestion.test.batch.classGroup.gradeLevel,
      correctAnswer: question.correctAnswer,
      tolerance: scheme.tolerance,
      toleranceIsRelative: scheme.toleranceIsRelative,
    };
  }

  const row = await prisma.assignmentSubmission.findUnique({
    where: { id: target.id },
    select: {
      contentText: true,
      assignment: {
        select: {
          title: true,
          instructions: true,
          maxMarks: true,
          subject: { select: { name: true } },
          batch: { select: { classGroup: { select: { gradeLevel: true } } } },
        },
      },
    },
  });

  if (!row) throw notFound('Submission');

  return {
    questionBody: `${row.assignment.title}\n\n${row.assignment.instructions}`,
    questionType: 'LONG_ANSWER',
    maxScore: row.assignment.maxMarks,
    modelAnswer: null,
    markingScheme: null,
    studentAnswer: row.contentText ?? '',
    subjectName: row.assignment.subject.name,
    gradeLevel: row.assignment.batch.classGroup.gradeLevel,
    correctAnswer: null,
  };
}

function targetKey(target: EvaluationTarget): Prisma.AiEvaluationWhereUniqueInput {
  switch (target.kind) {
    case 'practiceAnswer':
      return { practiceAnswerId: target.id };
    case 'testAnswer':
      return { testAnswerId: target.id };
    default:
      return { assignmentSubmissionId: target.id };
  }
}

function targetLink(target: EvaluationTarget): Record<string, string> {
  switch (target.kind) {
    case 'practiceAnswer':
      return { practiceAnswerId: target.id };
    case 'testAnswer':
      return { testAnswerId: target.id };
    default:
      return { assignmentSubmissionId: target.id };
  }
}

/**
 * A rule-based evaluation for anything objectively markable.
 *
 * Sending an MCQ to a language model would be slower, more expensive and less
 * reliable than comparing two strings. The AI path is reserved for answers that
 * genuinely need reading.
 */
function ruleBasedEvaluation(subject: EvaluationSubject): GeneratedEvaluation | null {
  const objective = ['MCQ_SINGLE', 'MCQ_MULTI', 'TRUE_FALSE', 'FILL_BLANK', 'NUMERICAL'];
  if (!objective.includes(subject.questionType)) return null;

  const question: GradableQuestion = {
    id: 'inline',
    type: subject.questionType as GradableType,
    marks: subject.maxScore,
    correctAnswer: subject.correctAnswer,
    ...(subject.tolerance !== undefined ? { tolerance: subject.tolerance } : {}),
    ...(subject.toleranceIsRelative !== undefined
      ? { toleranceIsRelative: subject.toleranceIsRelative }
      : {}),
  };

  const result = gradeAnswer(question, { responseText: subject.studentAnswer });
  if (result.marksAwarded === null) return null;

  const correct = result.isCorrect === true;

  return {
    score: Math.max(0, result.marksAwarded),
    maxScore: subject.maxScore,
    verdict: correct ? 'correct' : 'incorrect',
    whatWentRight: correct
      ? 'You picked the right answer.'
      : 'You attempted the question, which is where every correct answer starts.',
    whatWentWrong: correct ? null : result.note,
    whyItWentWrong: correct
      ? null
      : 'The response did not match the expected answer for this question.',
    correctApproach: correct
      ? null
      : subject.modelAnswer ?? 'Work back through the question and check each step against your notes.',
    improvementTip: correct
      ? null
      : 'Re-read the question once more before answering; small misreadings account for most of these.',
    conceptualErrors: [],
    calculationErrors: [],
    missingSteps: [],
    rubricBreakdown: null,
    confidence: 1,
  };
}

export interface EvaluationResult {
  evaluationId: string;
  score: number;
  maxScore: number;
  verdict: string;
  source: EvaluationSource;
  whatWentRight: string;
  whatWentWrong: string | null;
  whyItWentWrong: string | null;
  correctApproach: string | null;
  improvementTip: string | null;
}

/**
 * Evaluates one answer and persists the result.
 *
 * The output contract is the product promise: a student is never told only
 * "wrong". If the model returns a bare verdict, the validator rejects it and
 * the answer is left for a teacher rather than a useless evaluation being
 * stored and shown.
 */
export async function evaluateAnswer(
  auth: AuthContext,
  target: EvaluationTarget,
): Promise<EvaluationResult> {
  const subject = await loadSubject(target);

  if (subject.studentAnswer.trim().length === 0) {
    throw unprocessable('There is nothing to evaluate; the answer is empty.');
  }

  const ruleBased = ruleBasedEvaluation(subject);

  let evaluation: GeneratedEvaluation;
  let source: EvaluationSource;
  let provider: AiProviderName | null = null;
  let model: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let latencyMs: number | null = null;

  if (ruleBased) {
    evaluation = ruleBased;
    source = EvaluationSource.RULE_BASED;
  } else {
    const prompt = buildEvaluationPrompt({
      subject: subject.subjectName,
      questionBody: subject.questionBody,
      questionType: subject.questionType,
      maxScore: subject.maxScore,
      modelAnswer: subject.modelAnswer,
      markingScheme: subject.markingScheme,
      studentAnswer: subject.studentAnswer,
      studentClass: subject.gradeLevel,
    });

    const response = await complete(
      {
        feature: AiFeature.ANSWER_EVALUATION,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        json: true,
        temperature: 0.2,
      },
      { userId: auth.userId },
    );

    const parsed = parseModelJson(response.text);
    if (!parsed.ok) {
      logger.error({ error: parsed.reason }, 'evaluation response was not usable JSON');
      throw unprocessable(
        'The evaluator returned something unreadable. This answer has been left for your teacher.',
      );
    }

    const validated = validateEvaluation(parsed.value, subject.maxScore);
    if (!validated.ok) {
      logger.error({ error: validated.reason }, 'evaluation rejected by validation');
      throw unprocessable(
        `The evaluation was rejected because it was not useful enough to show you: ${validated.reason}. Your teacher will mark this one.`,
      );
    }

    evaluation = validated.value;
    source = EvaluationSource.AI;
    provider = providerEnum(response.provider);
    model = response.model;
    promptTokens = response.promptTokens;
    completionTokens = response.completionTokens;
    latencyMs = response.latencyMs;
  }

  const data = {
    ...targetLink(target),
    source,
    score: evaluation.score,
    maxScore: evaluation.maxScore,
    isCorrect: evaluation.verdict === 'correct',
    verdict: evaluation.verdict,
    whatWentRight: evaluation.whatWentRight,
    whatWentWrong: evaluation.whatWentWrong,
    whyItWentWrong: evaluation.whyItWentWrong,
    correctApproach: evaluation.correctApproach,
    improvementTip: evaluation.improvementTip,
    conceptualErrors: evaluation.conceptualErrors as unknown as Prisma.InputJsonValue,
    calculationErrors: evaluation.calculationErrors as unknown as Prisma.InputJsonValue,
    missingSteps: evaluation.missingSteps as unknown as Prisma.InputJsonValue,
    ...(evaluation.rubricBreakdown
      ? { rubricBreakdown: evaluation.rubricBreakdown as unknown as Prisma.InputJsonValue }
      : {}),
    confidence: evaluation.confidence,
    provider,
    model,
    promptTokens,
    completionTokens,
    latencyMs,
  };

  const record = await prisma.aiEvaluation.upsert({
    where: targetKey(target),
    update: data,
    create: data,
    select: { id: true },
  });

  // The mark is mirrored onto the answer row so the grading pipeline and the
  // dashboards read one number, not two that can disagree.
  if (target.kind === 'testAnswer') {
    await prisma.testAnswer.update({
      where: { id: target.id },
      data: { marksAwarded: evaluation.score, isCorrect: evaluation.verdict === 'correct' },
    });
  }

  return {
    evaluationId: record.id,
    score: evaluation.score,
    maxScore: evaluation.maxScore,
    verdict: evaluation.verdict,
    source,
    whatWentRight: evaluation.whatWentRight,
    whatWentWrong: evaluation.whatWentWrong,
    whyItWentWrong: evaluation.whyItWentWrong,
    correctApproach: evaluation.correctApproach,
    improvementTip: evaluation.improvementTip,
  };
}

/**
 * A teacher overriding the machine.
 *
 * The original is kept rather than replaced: an override is evidence about the
 * evaluator's reliability, and discarding it would hide a systematic problem.
 */
export async function overrideEvaluation(
  auth: AuthContext,
  evaluationId: string,
  input: { score: number; reason: string; teacherRemarks?: string | undefined },
) {
  if (auth.role !== Role.TEACHER && auth.role !== Role.ADMIN) {
    throw forbidden('Only a teacher or administrator can override an evaluation.');
  }

  const existing = await prisma.aiEvaluation.findUnique({
    where: { id: evaluationId },
    select: { id: true, score: true, maxScore: true, verdict: true },
  });

  if (!existing) throw notFound('Evaluation');

  if (input.score > existing.maxScore) {
    throw unprocessable(`That answer is out of ${existing.maxScore}.`);
  }

  return prisma.aiEvaluation.update({
    where: { id: evaluationId },
    data: {
      score: input.score,
      verdict:
        input.score >= existing.maxScore
          ? 'correct'
          : input.score > 0
            ? 'partially_correct'
            : 'incorrect',
      isCorrect: input.score >= existing.maxScore,
      isOverridden: true,
      overriddenById: auth.userId,
      overrideReason: input.reason,
      teacherRemarks: input.teacherRemarks ?? null,
      source: EvaluationSource.HYBRID,
    },
    select: { id: true, score: true, verdict: true, isOverridden: true },
  });
}

/**
 * How often teachers disagree with the evaluator.
 *
 * Worth surfacing plainly: a high override rate means the AI marking is not
 * trustworthy for that subject yet, and an institute deserves to know that
 * rather than infer it.
 */
export async function evaluationReliability(instituteId: string) {
  const [total, overridden] = await Promise.all([
    prisma.aiEvaluation.count({
      where: { source: { in: [EvaluationSource.AI, EvaluationSource.HYBRID] } },
    }),
    prisma.aiEvaluation.count({ where: { isOverridden: true } }),
  ]);

  const recent = await prisma.aiEvaluation.findMany({
    where: { isOverridden: true },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: {
      id: true,
      score: true,
      maxScore: true,
      overrideReason: true,
      updatedAt: true,
    },
  });

  return {
    instituteId,
    totalAiEvaluations: total,
    overridden,
    overrideRatePct: total > 0 ? Math.round((overridden / total) * 1000) / 10 : 0,
    recentOverrides: recent,
  };
}
