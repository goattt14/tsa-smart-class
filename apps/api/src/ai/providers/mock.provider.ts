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

  private static readonly SUBJECT_QUESTIONS: Record<string, string[]> = {
    Physics: [
      "State Newton's second law of motion and write its mathematical form.",
      'Why do you need a larger force to accelerate a heavier object by the same amount as a lighter one?',
      "Two objects push against each other with equal force. Why doesn't the heavier one simply stay still?",
      'A ray of light passes from air into water. Explain what happens to its path and why.',
      'How can you tell that the current in a wire is directly proportional to the voltage across it?',
      'What determines the direction of the magnetic field around a current-carrying wire?',
      'A ball is thrown straight up and falls back down. Explain how its kinetic and potential energy change during the flight.',
      'Why does the Moon stay in orbit around the Earth instead of flying off into space?',
      'Two ice skaters push off from each other and glide apart. Explain what happens to their speeds using conservation of momentum.',
      "Why does a plane mirror produce an image that looks 'flipped' left-to-right compared to the real object?",
    ],
    Mathematics: [
      'Solve x^2 - 5x + 6 = 0 by factoring, and explain each step.',
      'How does the discriminant tell you the number of real roots of a quadratic equation, without solving it?',
      'When would you use the quadratic formula instead of trying to factor?',
      'Find the 10th term of the arithmetic progression 3, 7, 11, 15, ... and explain your method.',
      'If a quadratic polynomial has zeroes 2 and 3, what can you say about its coefficients?',
      "In a right triangle, how do you decide which side is 'opposite' and which is 'adjacent' for a given angle?",
      'State the Pythagoras theorem and explain when it applies.',
      'How would you find the distance between the points (2, 3) and (5, 7)?',
      'How do the area and circumference of a circle depend on its radius?',
      'What is the difference between the mean, median, and mode of a data set, and when might they differ a lot?',
    ],
    Chemistry: [
      'Why must a chemical equation be balanced before it is considered complete?',
      "What's the difference between a combination reaction and a decomposition reaction? Give an example of each.",
      'In the reaction between iron and copper sulphate solution, why does iron displace the copper?',
      'What does a pH value below 7 tell you about a solution?',
      'How is common salt formed from an acid and a base?',
      'Why does gold barely react with anything, while sodium reacts violently even with water?',
      'How does rusting happen, and what are two ways to prevent it?',
      'Why can carbon form so many more compounds than most other elements?',
      'What happens to atomic size as you move across a period in the periodic table, and why?',
      'What is a mole, and why is it a useful unit in chemistry?',
    ],
    Biology: [
      'What is the difference between autotrophic and heterotrophic nutrition? Give an example of each.',
      'Why does aerobic respiration release more energy than anaerobic respiration?',
      'Why does the human heart pump blood through two separate circulations instead of just one?',
      'What role do the kidneys play in maintaining the balance of water and salts in the body?',
      'How does a reflex action differ from a normal, thought-out response?',
      'What is the key difference between asexual and sexual reproduction, and why does the variation from sexual reproduction matter?',
      "According to Mendel's experiments, why can a trait 'skip' a generation and then reappear later?",
      'What happens to the amount of energy available as you move up a food chain, and why?',
      'How would you explain the relationship between the nervous system and the endocrine system in controlling the body?',
      'Why is photosynthesis specifically dependent on sunlight rather than just any source of light or heat?',
    ],
    English: [
      "Change this sentence to passive voice: 'The teacher explained the lesson.'",
      "Convert to reported speech: She said, 'I am tired.'",
      'Explain the difference between a simile and a metaphor, with an example of each.',
      "Why does subject-verb agreement matter, and what's a common mistake people make with it?",
      'What are the key parts of a formal letter, in order?',
      'How would you structure a five-paragraph essay?',
      'Why is it useful to skim a passage before reading it closely for detail?',
      'Explain how a misplaced comma can completely change the meaning of a sentence.',
      'What is the difference between simple past and past continuous tense? Give an example of each.',
      'When would you use a semicolon instead of a full stop or a comma?',
    ],
  };

  private static readonly FALLBACK_QUESTIONS = [
    'Explain the central idea of this topic in your own words.',
    'Walk through a typical problem on this topic step by step.',
    'What is the most common mistake students make on this topic, and how do you avoid it?',
  ];

  private vivaQuestionJson(prompt: string): string {
    const subject = /^Subject:\s*(.+)$/m.exec(prompt)?.[1]?.trim() ?? '';
    const isFollowUp = prompt.includes('This turn is a follow-up');

    const askedBlock = /Already asked, do not repeat these:\n([\s\S]*?)(?:\n\n|$)/.exec(prompt);
    const askedCount = askedBlock?.[1] ? askedBlock[1].split('\n').filter((l) => l.trim()).length : 0;

    const bank = isFollowUp
      ? [
          'Can you go one step further and explain why that happens?',
          'What would change in your answer if the numbers or conditions here were different?',
          'How would you defend that answer to someone who disagreed with you?',
        ]
      : (MockProvider.SUBJECT_QUESTIONS[subject] ?? MockProvider.FALLBACK_QUESTIONS);

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
