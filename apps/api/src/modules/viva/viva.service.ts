import {
  AiFeature,
  AiProviderName,
  Difficulty,
  EvaluationSource,
  Prisma,
  Role,
  VivaStatus,
} from '@prisma/client';
import { parseModelJson, validateEvaluation } from '../../ai/parsing';
import type { SourcePassage } from '../../ai/prompts';
import { complete } from '../../ai/router';
import { assessSpeech } from '../../ai/stt';
import {
  buildFollowUpPrompt,
  buildVivaEvaluationPrompt,
  buildVivaQuestionPrompt,
  buildVivaSummaryPrompt,
} from '../../ai/viva.prompts';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/http-error';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { studentVisibilityFilter } from '../../lib/scope';
import type { AuthContext } from '../../types/express';
import { retrievePassages } from '../ai/rag.service';
import { recordOutcome } from '../performance/performance.service';
import { CONSENT_VERSION } from '../proctoring/proctoring.signals';
import {
  applyAnswer,
  decideNext,
  DEFAULT_VIVA_POLICY,
  describeOutcome,
  scoreViva,
  type AnswerOutcome,
  type VivaState,
} from './viva.engine';

const MARKS_PER_QUESTION = 10;

function providerEnum(name: string): AiProviderName {
  const upper = name.toUpperCase();
  return (Object.values(AiProviderName) as string[]).includes(upper)
    ? (upper as AiProviderName)
    : AiProviderName.MOCK;
}

async function loadOwnSession(auth: AuthContext, sessionId: string) {
  const session = await prisma.vivaSession.findFirst({
    where: { id: sessionId, student: studentVisibilityFilter(auth) },
    select: {
      id: true,
      studentId: true,
      subjectId: true,
      topicId: true,
      status: true,
      startedAt: true,
      durationMin: true,
      startDifficulty: true,
      voiceEnabled: true,
      proctoringEnabled: true,
      consentGivenAt: true,
      consentVersion: true,
      subject: { select: { name: true } },
      topic: { select: { name: true } },
    },
  });

  if (!session) throw notFound('Viva session');

  if (auth.role === Role.STUDENT && session.studentId !== auth.profileId) {
    throw forbidden('That is not your viva.');
  }

  return session;
}

export async function scheduleViva(
  auth: AuthContext,
  input: {
    studentId: string;
    subjectId: string;
    topicId?: string | undefined;
    aiTaskId?: string | undefined;
    selfStudySessionId?: string | undefined;
    durationMin: number;
    voiceEnabled: boolean;
    proctoringEnabled: boolean;
    startDifficulty: Difficulty;
  },
) {
  const subject = await prisma.subject.findFirst({
    where: { id: input.subjectId, instituteId: auth.instituteId, deletedAt: null },
    select: { id: true },
  });
  if (!subject) throw notFound('Subject');

  return prisma.vivaSession.create({
    data: {
      studentId: input.studentId,
      subjectId: input.subjectId,
      topicId: input.topicId ?? null,
      aiTaskId: input.aiTaskId ?? null,
      selfStudySessionId: input.selfStudySessionId ?? null,
      durationMin: input.durationMin,
      voiceEnabled: input.voiceEnabled,
      proctoringEnabled: input.proctoringEnabled,
      startDifficulty: input.startDifficulty,
      // A monitored viva cannot begin until consent has been recorded, so it
      // starts in a state that says exactly that.
      status: input.proctoringEnabled ? VivaStatus.CONSENT_PENDING : VivaStatus.SCHEDULED,
    },
    select: { id: true, status: true, durationMin: true },
  });
}

/**
 * Records consent.
 *
 * Versioned deliberately. If the terms change, previously given consent stops
 * counting and is asked for again, rather than a student being held to
 * something they agreed to under different wording months earlier.
 */
export async function recordConsent(
  auth: AuthContext,
  sessionId: string,
  input: { cameraGranted: boolean; microphoneGranted: boolean; accepted: boolean },
) {
  const session = await loadOwnSession(auth, sessionId);

  if (!input.accepted) {
    // Declining is not a failure state. Monitoring is switched off and the
    // session continues.
    return prisma.vivaSession.update({
      where: { id: sessionId },
      data: { proctoringEnabled: false, status: VivaStatus.SCHEDULED },
      select: { id: true, status: true, proctoringEnabled: true },
    });
  }

  return prisma.vivaSession.update({
    where: { id: sessionId },
    data: {
      consentGivenAt: new Date(),
      consentVersion: CONSENT_VERSION,
      proctoringEnabled: session.proctoringEnabled && input.cameraGranted,
      voiceEnabled: session.voiceEnabled && input.microphoneGranted,
      status: VivaStatus.SCHEDULED,
    },
    select: { id: true, status: true, proctoringEnabled: true, voiceEnabled: true },
  });
}

/** Rebuilds the engine's view of the session from what is stored. */
async function rebuildState(sessionId: string, startDifficulty: Difficulty): Promise<VivaState> {
  const questions = await prisma.vivaQuestion.findMany({
    where: { vivaSessionId: sessionId },
    orderBy: { orderIndex: 'asc' },
    select: {
      difficulty: true,
      isFollowUp: true,
      parentId: true,
      askedAt: true,
      answer: {
        select: {
          transcript: true,
          sttConfidence: true,
          evaluation: { select: { score: true, maxScore: true } },
        },
      },
    },
  });

  const outcomes: AnswerOutcome[] = [];
  let depth = 0;

  for (const question of questions) {
    depth = question.isFollowUp ? depth + 1 : 0;

    const transcript = question.answer?.transcript ?? '';
    const quality = assessSpeech(transcript, question.answer?.sttConfidence ?? null);
    const evaluation = question.answer?.evaluation;

    outcomes.push({
      creditFraction:
        evaluation && evaluation.maxScore > 0 ? evaluation.score / evaluation.maxScore : 0,
      difficulty: question.difficulty,
      wasSilent: quality.wordCount === 0,
      wasUnintelligible: quality.unintelligible,
      wasShallow: false,
      isFollowUp: question.isFollowUp,
      followUpDepth: depth,
    });
  }

  const first = questions[0];
  const elapsedSec = first ? Math.floor((Date.now() - first.askedAt.getTime()) / 1000) : 0;
  const last = outcomes[outcomes.length - 1];

  return {
    askedCount: questions.length,
    elapsedSec,
    currentDifficulty: last?.difficulty ?? startDifficulty,
    outcomes,
  };
}

async function passagesFor(
  session: { subjectId: string; topicId: string | null; topic: { name: string } | null; subject: { name: string } },
  instituteId: string,
): Promise<{ passages: SourcePassage[]; chunkIds: string[] }> {
  const query = [session.topic?.name, session.subject.name].filter(Boolean).join(' ');

  const retrieval = await retrievePassages(
    query,
    { subjectId: session.subjectId, topicId: session.topicId ?? undefined },
    instituteId,
  );

  return {
    passages: retrieval.chunks.map((chunk, index) => ({
      index: index + 1,
      content: chunk.content,
      sectionTitle: chunk.sectionTitle,
    })),
    chunkIds: retrieval.chunks.map((chunk) => chunk.chunkId),
  };
}

export interface NextTurn {
  finished: boolean;
  question?: {
    id: string;
    orderIndex: number;
    body: string;
    difficulty: Difficulty;
    isFollowUp: boolean;
    probesConcept: string | null;
  };
  endReason?: string;
  progress: { asked: number; maxQuestions: number; elapsedSec: number; durationMin: number };
}

/**
 * Produces the next question, or ends the viva.
 *
 * The engine decides what kind of turn comes next; the model only writes the
 * words. Keeping that split means the examining behaviour is deterministic and
 * testable even though the question text is not.
 */
export async function nextTurn(auth: AuthContext, sessionId: string): Promise<NextTurn> {
  const session = await loadOwnSession(auth, sessionId);

  if (session.status === VivaStatus.CONSENT_PENDING) {
    throw unprocessable('This viva is monitored. Give or decline consent before starting.');
  }
  if (session.status === VivaStatus.COMPLETED) {
    throw conflict('This viva has already finished.');
  }

  if (session.status === VivaStatus.SCHEDULED) {
    await prisma.vivaSession.update({
      where: { id: sessionId },
      data: { status: VivaStatus.IN_PROGRESS, startedAt: new Date() },
    });
  }

  const policy = { ...DEFAULT_VIVA_POLICY, durationMin: session.durationMin };
  const state = await rebuildState(sessionId, session.startDifficulty);
  const decision = decideNext(state, policy);

  const progress = {
    asked: state.askedCount,
    maxQuestions: policy.maxQuestions,
    elapsedSec: state.elapsedSec,
    durationMin: session.durationMin,
  };

  if (decision.kind === 'END') {
    await finishViva(auth, sessionId);
    return { finished: true, endReason: decision.detail, progress };
  }

  const { passages, chunkIds } = await passagesFor(session, auth.instituteId);

  if (passages.length === 0) {
    await prisma.vivaSession.update({
      where: { id: sessionId },
      data: { status: VivaStatus.ABANDONED },
    });
    throw unprocessable(
      'There is no indexed material for this topic, so no grounded question can be asked. Ask your teacher to upload the notes.',
    );
  }

  const asked = await prisma.vivaQuestion.findMany({
    where: { vivaSessionId: sessionId },
    select: { id: true, body: true, expectedPoints: true, orderIndex: true },
    orderBy: { orderIndex: 'asc' },
  });

  const previous = asked[asked.length - 1];

  let prompt: { system: string; user: string };

  if (decision.kind === 'PROBE' && previous) {
    const lastAnswer = await prisma.vivaAnswer.findUnique({
      where: { vivaQuestionId: previous.id },
      select: { transcript: true },
    });

    prompt = buildFollowUpPrompt({
      subject: session.subject.name,
      originalQuestion: previous.body,
      studentAnswer: lastAnswer?.transcript ?? '',
      expectedPoints: Array.isArray(previous.expectedPoints)
        ? (previous.expectedPoints as string[])
        : [],
      passages,
    });
  } else {
    prompt = buildVivaQuestionPrompt({
      subject: session.subject.name,
      topic: session.topic?.name ?? null,
      gradeLevel: null,
      difficulty: decision.difficulty,
      passages,
      asked: asked.map((q) => q.body),
    });
  }

  const response = await complete(
    {
      feature: AiFeature.VIVA_QUESTION,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      json: true,
      temperature: 0.6,
    },
    { userId: auth.userId },
  );

  const parsed = parseModelJson<{
    body?: string;
    expectedPoints?: string[];
    probesConcept?: string;
    sourceChunkIndexes?: number[];
  }>(response.text);

  if (!parsed.ok || !parsed.value?.body) {
    throw unprocessable('The examiner could not produce a question. Try again in a moment.');
  }

  const sourceIds = (parsed.value.sourceChunkIndexes ?? [])
    .map((index) => chunkIds[index - 1])
    .filter((id): id is string => Boolean(id));

  const question = await prisma.vivaQuestion.create({
    data: {
      vivaSessionId: sessionId,
      parentId: decision.kind === 'PROBE' ? (previous?.id ?? null) : null,
      orderIndex: state.askedCount,
      body: parsed.value.body,
      expectedPoints: (parsed.value.expectedPoints ?? []) as unknown as Prisma.InputJsonValue,
      difficulty: decision.difficulty as Difficulty,
      isFollowUp: decision.kind === 'PROBE',
      probesConcept: parsed.value.probesConcept ?? null,
      sourceChunkIds: sourceIds as unknown as Prisma.InputJsonValue,
    },
    select: {
      id: true,
      orderIndex: true,
      body: true,
      difficulty: true,
      isFollowUp: true,
      probesConcept: true,
    },
  });

  return { finished: false, question, progress };
}

export interface AnswerResult {
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

/**
 * Records and marks one answer.
 *
 * An unintelligible recording is stored and reported but never evaluated, so a
 * failed microphone cannot become a bad mark. That case returns evaluated:false
 * with an explanation the student can act on.
 */
export async function submitAnswer(
  auth: AuthContext,
  questionId: string,
  input: {
    transcript: string;
    sttProvider?: string | undefined;
    sttConfidence?: number | undefined;
    durationSec?: number | undefined;
    audioAssetId?: string | undefined;
  },
): Promise<AnswerResult> {
  const question = await prisma.vivaQuestion.findFirst({
    where: { id: questionId, vivaSession: { student: studentVisibilityFilter(auth) } },
    select: {
      id: true,
      body: true,
      expectedPoints: true,
      difficulty: true,
      vivaSession: {
        select: {
          id: true,
          studentId: true,
          topicId: true,
          status: true,
          subject: { select: { name: true } },
        },
      },
      answer: { select: { id: true } },
    },
  });

  if (!question) throw notFound('Viva question');

  if (auth.role === Role.STUDENT && question.vivaSession.studentId !== auth.profileId) {
    throw forbidden('That is not your viva.');
  }

  if (question.answer) throw conflict('That question has already been answered.');

  const quality = assessSpeech(input.transcript, input.sttConfidence ?? null);

  const answer = await prisma.vivaAnswer.create({
    data: {
      vivaQuestionId: questionId,
      transcript: input.transcript,
      sttProvider: input.sttProvider ?? null,
      sttConfidence: input.sttConfidence ?? null,
      durationSec: input.durationSec ?? null,
      audioAssetId: input.audioAssetId ?? null,
    },
    select: { id: true },
  });

  if (quality.unintelligible || quality.wordCount === 0) {
    return {
      evaluated: false,
      score: null,
      maxScore: MARKS_PER_QUESTION,
      feedback: null,
      speechNote:
        quality.note ?? 'Nothing usable was recorded. This has not been counted against you.',
    };
  }

  const prompt = buildVivaEvaluationPrompt({
    subject: question.vivaSession.subject.name,
    question: question.body,
    expectedPoints: Array.isArray(question.expectedPoints)
      ? (question.expectedPoints as string[])
      : [],
    transcript: input.transcript,
    maxScore: MARKS_PER_QUESTION,
    wasSpoken: Boolean(input.sttProvider),
  });

  const response = await complete(
    {
      feature: AiFeature.VIVA_EVALUATION,
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
    logger.error({ error: parsed.reason }, 'viva evaluation was not usable JSON');
    return {
      evaluated: false,
      score: null,
      maxScore: MARKS_PER_QUESTION,
      feedback: null,
      speechNote: 'That answer could not be marked automatically. Your teacher will review it.',
    };
  }

  const validated = validateEvaluation(parsed.value, MARKS_PER_QUESTION);
  if (!validated.ok) {
    logger.error({ error: validated.reason }, 'viva evaluation rejected by validation');
    return {
      evaluated: false,
      score: null,
      maxScore: MARKS_PER_QUESTION,
      feedback: null,
      speechNote: 'The feedback was not clear enough to show you. Your teacher will review this one.',
    };
  }

  const evaluation = validated.value;

  await prisma.aiEvaluation.create({
    data: {
      vivaAnswerId: answer.id,
      source: EvaluationSource.AI,
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
      calculationErrors: (evaluation as any).calculationErrors as unknown as Prisma.InputJsonValue,
      missingSteps: (evaluation as any).missingSteps as unknown as Prisma.InputJsonValue,
      rubricBreakdown: (evaluation as any).rubricBreakdown as unknown as Prisma.InputJsonValue,
      confidence: evaluation.confidence,
      provider: providerEnum(response.provider),
      model: response.model,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      latencyMs: response.latencyMs,
    },
  });

  // Mastery moves on every answer, so a viva feeds the same picture the written
  // work does rather than sitting in its own silo.
  if (question.vivaSession.topicId) {
    await recordOutcome(question.vivaSession.studentId, question.vivaSession.topicId, {
      isCorrect: evaluation.verdict === 'correct',
      creditFraction: evaluation.score / evaluation.maxScore,
      difficulty: question.difficulty,
    });
  }

  return {
    evaluated: true,
    score: evaluation.score,
    maxScore: evaluation.maxScore,
    feedback: {
      whatWentRight: evaluation.whatWentRight,
      whatWentWrong: evaluation.whatWentWrong,
      whyItWentWrong: evaluation.whyItWentWrong,
      correctApproach: evaluation.correctApproach,
      improvementTip: evaluation.improvementTip,
    },
    speechNote: quality.note,
  };
}

/** Closes the session, scores it and writes the summary. */
export async function finishViva(auth: AuthContext, sessionId: string) {
  const session = await loadOwnSession(auth, sessionId);

  if (session.status === VivaStatus.COMPLETED) {
    return prisma.vivaSession.findUniqueOrThrow({ where: { id: sessionId } });
  }

  const questions = await prisma.vivaQuestion.findMany({
    where: { vivaSessionId: sessionId },
    orderBy: { orderIndex: 'asc' },
    select: {
      body: true,
      difficulty: true,
      isFollowUp: true,
      answer: {
        select: {
          transcript: true,
          sttConfidence: true,
          durationSec: true,
          evaluation: { select: { score: true, maxScore: true } },
        },
      },
    },
  });

  const outcomes: AnswerOutcome[] = [];
  let totalWords = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;
  let speakingSec = 0;
  let depth = 0;

  for (const question of questions) {
    depth = question.isFollowUp ? depth + 1 : 0;

    const transcript = question.answer?.transcript ?? '';
    const quality = assessSpeech(transcript, question.answer?.sttConfidence ?? null);
    const evaluation = question.answer?.evaluation;

    totalWords += quality.wordCount;
    speakingSec += question.answer?.durationSec ?? 0;

    if (question.answer?.sttConfidence !== null && question.answer?.sttConfidence !== undefined) {
      confidenceSum += question.answer.sttConfidence;
      confidenceCount += 1;
    }

    outcomes.push({
      creditFraction:
        evaluation && evaluation.maxScore > 0 ? evaluation.score / evaluation.maxScore : 0,
      difficulty: question.difficulty,
      wasSilent: quality.wordCount === 0,
      wasUnintelligible: quality.unintelligible,
      wasShallow: false,
      isFollowUp: question.isFollowUp,
      followUpDepth: depth,
    });
  }

  const score = scoreViva(outcomes, {
    totalWords,
    avgSttConfidence: confidenceCount > 0 ? confidenceSum / confidenceCount : null,
    speakingSec,
  });

  let summary = describeOutcome(score);
  let strengths: string[] = [];
  let weaknesses: { point: string; action: string }[] = [];

  // A summary is only worth generating when there was enough of a session to
  // summarise; below that the plain-language fallback is more honest.
  if (!score.isInconclusive) {
    try {
      const prompt = buildVivaSummaryPrompt({
        subject: session.subject.name,
        topic: session.topic?.name ?? null,
        exchanges: questions
          .filter((q) => q.answer)
          .map((q) => ({
            question: q.body,
            answer: q.answer?.transcript ?? '',
            score: q.answer?.evaluation?.score ?? 0,
            maxScore: q.answer?.evaluation?.maxScore ?? MARKS_PER_QUESTION,
          })),
        conceptualScore: score.conceptualScore,
        communicationScore: score.communicationScore,
      });

      const response = await complete(
        {
          feature: AiFeature.VIVA_EVALUATION,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          json: true,
          temperature: 0.4,
        },
        { userId: auth.userId },
      );

      const parsed = parseModelJson<{
        summary?: string;
        strengths?: string[];
        weaknesses?: { point: string; action: string }[];
      }>(response.text);

      if (parsed.ok && parsed.value?.summary) {
        summary = parsed.value.summary;
        strengths = parsed.value.strengths ?? [];
        weaknesses = parsed.value.weaknesses ?? [];
      }
    } catch (error) {
      logger.warn({ err: error, sessionId }, 'viva summary generation failed; using the fallback');
    }
  }

  return prisma.vivaSession.update({
    where: { id: sessionId },
    data: {
      status: VivaStatus.COMPLETED,
      endedAt: new Date(),
      overallScore: score.overallScore,
      maxScore: score.maxScore,
      conceptualScore: score.conceptualScore,
      communicationScore: score.communicationScore,
      summary,
      strengths: strengths as unknown as Prisma.InputJsonValue,
      weaknesses: weaknesses as unknown as Prisma.InputJsonValue,
      endDifficulty: outcomes[outcomes.length - 1]?.difficulty ?? null,
    },
  });
}

export async function listVivas(
  auth: AuthContext,
  args: { studentId?: string | undefined; status?: VivaStatus | undefined; limit: number },
) {
  return prisma.vivaSession.findMany({
    where: {
      student: studentVisibilityFilter(auth),
      ...(args.studentId ? { studentId: args.studentId } : {}),
      ...(args.status ? { status: args.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: args.limit,
    select: {
      id: true,
      status: true,
      durationMin: true,
      overallScore: true,
      conceptualScore: true,
      communicationScore: true,
      summary: true,
      startedAt: true,
      endedAt: true,
      voiceEnabled: true,
      proctoringEnabled: true,
      subject: { select: { id: true, name: true, colorHex: true } },
      topic: { select: { id: true, name: true } },
      _count: { select: { questions: true } },
    },
  });
}

export async function vivaTranscript(auth: AuthContext, sessionId: string) {
  const session = await loadOwnSession(auth, sessionId);

  const questions = await prisma.vivaQuestion.findMany({
    where: { vivaSessionId: sessionId },
    orderBy: { orderIndex: 'asc' },
    select: {
      id: true,
      orderIndex: true,
      body: true,
      difficulty: true,
      isFollowUp: true,
      probesConcept: true,
      expectedPoints: true,
      answer: {
        select: {
          transcript: true,
          sttConfidence: true,
          durationSec: true,
          evaluation: {
            select: {
              score: true,
              maxScore: true,
              verdict: true,
              whatWentRight: true,
              whatWentWrong: true,
              whyItWentWrong: true,
              correctApproach: true,
              improvementTip: true,
              isOverridden: true,
            },
          },
        },
      },
    },
  });

  const full = await prisma.vivaSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: {
      overallScore: true,
      conceptualScore: true,
      communicationScore: true,
      summary: true,
      strengths: true,
      weaknesses: true,
      status: true,
    },
  });

  return { session: { ...session, ...full }, exchanges: questions };
}
