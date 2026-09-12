import crypto from 'node:crypto';
import { AiProviderName } from '@prisma/client';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../types';

/**
 * A provider that needs no API key.
 *
 * This exists so the entire academic loop — generate a task, answer it, get an
 * evaluation — can be demonstrated, tested and developed against with zero
 * spend and no network. It is not a simulation of intelligence: it returns
 * well-formed, obviously synthetic output so nobody can mistake a mock run for
 * a real one.
 */
export class MockProvider implements AiProvider {
  public readonly name = AiProviderName.MOCK;
  public readonly supportsEmbedding = true;

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const started = Date.now();
    const prompt = request.messages.map((m) => m.content).join('\n');

    const text = request.json ? this.jsonFor(request, prompt) : this.proseFor(prompt);

    return {
      text,
      provider: this.name,
      model: 'mock-1',
      promptTokens: Math.ceil(prompt.length / 4),
      completionTokens: Math.ceil(text.length / 4),
      latencyMs: Date.now() - started,
    };
  }

  private jsonFor(request: CompletionRequest, prompt: string): string {
    if (request.feature === 'ANSWER_EVALUATION' || request.feature === 'VIVA_EVALUATION') {
      return this.evaluationJson(prompt, request.feature === 'VIVA_EVALUATION');
    }

    if (request.feature === 'VIVA_QUESTION') {
      return this.vivaQuestionJson(prompt);
    }

    if (request.feature === 'TASK_GENERATION') {
      const count = Number(/questionCount"?\s*[:=]\s*(\d+)/.exec(prompt)?.[1] ?? 5);

      return JSON.stringify({
        questions: Array.from({ length: Math.min(count, 10) }, (_, i) => ({
          type: i % 3 === 0 ? 'MCQ_SINGLE' : i % 3 === 1 ? 'NUMERICAL' : 'SHORT_ANSWER',
          difficulty: 'MEDIUM',
          body: `[MOCK] Practice question ${i + 1} generated from the supplied material.`,
          ...(i % 3 === 0
            ? {
                options: [
                  { id: 'a', text: 'First option' },
                  { id: 'b', text: 'Second option' },
                  { id: 'c', text: 'Third option' },
                  { id: 'd', text: 'Fourth option' },
                ],
                correctAnswer: 'b',
              }
            : {}),
          ...(i % 3 === 1 ? { correctAnswer: 42 } : {}),
          ...(i % 3 === 2 ? { modelAnswer: 'A model answer would appear here.' } : {}),
          explanation: 'The mock provider does not reason about the material.',
          marks: 2,
          expectedTimeSec: 120,
          sourceChunkIndexes: [0],
        })),
      });
    }

    return JSON.stringify({ mock: true, note: 'No mock shape defined for this feature.' });
  }

  private evaluationJson(prompt: string, isViva: boolean): string {
    const maxScoreMatch = /Out of:\s*(\d+)/.exec(prompt);
    const maxScore = maxScoreMatch?.[1] ? Number(maxScoreMatch[1]) : 10;

    const answerMatch = /---\n([\s\S]*?)\n---/.exec(prompt);
    const rawAnswer = (answerMatch?.[1] ?? '').trim();

    const STOPWORDS = new Set([
      'the', 'is', 'a', 'an', 'to', 'and', 'of', 'in', 'that', 'this', 'it', 'for', 'on', 'with',
      'as', 'at', 'by', 'from', 'or', 'be', 'are', 'was', 'were', 'has', 'have', 'had', 'not',
      'but', 'so', 'how', 'why', 'what', 'when', 'which', 'because', 'if', 'then', 'can', 'will',
      'would', 'should', 'you', 'your', 'we', 'they', 'their', 'its', 'than', 'both', 'each',
      'some', 'no', 'yes', 'do', 'does', 'did', 'says', 'said', 'equals', 'any',
    ]);
    const words = rawAnswer.match(/[a-zA-Z']{2,}/g) ?? [];
    const stopwordCount = words.filter((w) => STOPWORDS.has(w.toLowerCase())).length;
    const looksReal = rawAnswer.length >= 8 && words.length >= 4 && stopwordCount >= 1;

    if (!looksReal) {
      const seed = crypto.createHash('sha256').update(rawAnswer || 'empty').digest()[0] ?? 0;
      const notes = [
        'Nothing that reads as an answer to the question came through — it may have been cut off or not captured properly.',
        "What's there doesn't form a real sentence, so there's nothing to credit yet.",
        'This looks empty or unreadable rather than a genuine attempt.',
      ];
      return JSON.stringify({
        score: 0,
        maxScore,
        verdict: 'incorrect',
        whatWentRight: 'An attempt was submitted, but no usable content came through.',
        whatWentWrong: notes[seed % notes.length],
        whyItWentWrong: 'Score zero: there is nothing here to evaluate against the question.',
        correctApproach: 'Try again and say (or type) a full sentence answering what was asked.',
        improvementTip: isViva
          ? 'If you were speaking, check your microphone picked up your answer before submitting.'
          : 'Make sure your answer is fully written out before submitting.',
        conceptualErrors: [],
        calculationErrors: [],
        missingSteps: [],
        confidence: 0.9,
        mockNotice: 'Generated by the mock provider. Configure AI_PROVIDER for real evaluation.',
      });
    }

    const seed = crypto.createHash('sha256').update(rawAnswer).digest()[0] ?? 0;
    const score = Math.round(maxScore * (0.55 + (seed % 20) / 100));

    return JSON.stringify({
      score,
      maxScore,
      verdict: 'partially_correct',
      whatWentRight: 'A genuine, on-topic attempt was made and submitted in full sentences.',
      whatWentWrong:
        'The mock provider cannot check this against the subject matter — configure a real AI provider for an actual correctness check.',
      whyItWentWrong: 'This is a placeholder judgement, not a real assessment of the content.',
      correctApproach: 'Not evaluated — a real AI provider is needed to mark this properly.',
      improvementTip: 'Ask your teacher to enable a real AI provider for graded feedback.',
      conceptualErrors: [],
      calculationErrors: [],
      missingSteps: [],
      confidence: 0.3,
      mockNotice: 'Generated by the mock provider. Configure AI_PROVIDER for real evaluation.',
    });
  }

  private vivaQuestionJson(prompt: string): string {
    const subject = /^Subject:\s*(.+)$/m.exec(prompt)?.[1]?.trim() ?? 'this subject';
    const isFollowUp = prompt.includes('This turn is a follow-up');

    const passages = [...prompt.matchAll(/\[(\d+)\](?:\s—[^\n]*)?\n([\s\S]{0,220}?)(?=\n\[\d+\]|\n\n|$)/g)]
      .map((m) => m[2]?.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, ''))
      .filter((text): text is string => Boolean(text));

    const askedBlock = /Already asked, do not repeat these:\n([\s\S]*?)(?:\n\n|$)/.exec(prompt);
    const askedCount = askedBlock?.[1] ? askedBlock[1].split('\n').filter((l) => l.trim()).length : 0;

    const snippet = passages.length > 0 ? passages[askedCount % passages.length] : undefined;

    const bank = isFollowUp
      ? [
          'Can you go a step deeper on that — why does that happen, specifically?',
          'What would change in your answer if one of those conditions were different?',
          'How would you justify that to someone who disagreed with you?',
        ]
      : [
          snippet
            ? `Based on the material on "${snippet}...", can you explain the main idea in your own words?`
            : `Can you explain the key idea from this part of ${subject} in your own words?`,
          snippet
            ? `The notes cover "${snippet}...". Walk me through how you'd use that to solve a typical ${subject} problem.`
            : `Walk me through how you would approach a typical problem on this topic in ${subject}.`,
          snippet
            ? `Looking at "${snippet}...", what's the most important thing to remember here, and why?`
            : `What is the most important thing to remember about this part of ${subject}, and why?`,
        ];

    const body = `[MOCK] ${bank[askedCount % bank.length]}`;

    return JSON.stringify({
      body,
      expectedPoints: [
        'Mentions the core concept from the source material',
        "Explains it in the student's own words, not a verbatim recall",
      ],
      probesConcept: 'core understanding',
      sourceChunkIndexes: [1],
    });
  }

  private proseFor(prompt: string): string {
    return [
      '[MOCK RESPONSE] The AI provider is not configured, so this is placeholder text.',
      '',
      `The request was ${prompt.length} characters long.`,
      'Set AI_PROVIDER and the matching API key to get a real answer.',
    ].join('\n');
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const started = Date.now();
    const dimension = 1536;

    const baseSeed = crypto.createHash('sha256').update('tsa-mock-embedding-base').digest();

    const vectors = request.input.map((text) => {
      const seed = crypto.createHash('sha256').update(text).digest();
      const vector = new Array<number>(dimension);

      for (let i = 0; i < dimension; i += 1) {
        const baseByte = baseSeed[i % baseSeed.length] ?? 0;
        const base = (baseByte / 255) * 2 - 1;
        const jitterByte = seed[i % seed.length] ?? 0;
        const jitter = ((jitterByte / 255) * 2 - 1) * Math.cos(i * 0.017 + jitterByte);
        vector[i] = base + jitter * 0.15;
      }

      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
      return vector.map((v) => v / norm);
    });

    return {
      vectors,
      provider: this.name,
      model: 'mock-embed-1',
      totalTokens: request.input.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
      latencyMs: Date.now() - started,
    };
  }
}
