import { GoogleGenerativeAI } from '@google/generative-ai';
import { AiProviderName } from '@prisma/client';
import { env } from '../../config/env';
import { AiError } from '../types';
import { translate } from './openai.provider';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../types';

export class GeminiProvider implements AiProvider {
  public readonly name = AiProviderName.GEMINI;
  public readonly supportsEmbedding = true;

  private client: GoogleGenerativeAI;

  constructor() {
    if (!env.GOOGLE_API_KEY) {
      throw new AiError('GOOGLE_API_KEY is not set.', 'NO_CREDENTIALS', false, this.name);
    }
    this.client = new GoogleGenerativeAI(env.GOOGLE_API_KEY);
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const started = Date.now();
    const modelName = (request.fast ? env.AI_FAST_MODEL : env.AI_TEXT_MODEL) ?? 'gemini-1.5-flash';

    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    try {
      const model = this.client.getGenerativeModel({
        model: modelName,
        ...(system ? { systemInstruction: system } : {}),
        generationConfig: {
          maxOutputTokens: request.maxTokens ?? env.AI_MAX_OUTPUT_TOKENS,
          temperature: request.temperature ?? 0.3,
          ...(request.json ? { responseMimeType: 'application/json' } : {}),
        },
      });

      const result = await model.generateContent({
        contents: request.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
      });

      const text = result.response.text();
      const usage = result.response.usageMetadata;

      return {
        text,
        provider: this.name,
        model: modelName,
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      throw translate(error, this.name);
    }
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const started = Date.now();
    const embeddingModel = env.AI_EMBEDDING_MODEL ?? 'text-embedding-004';

    try {
      const model = this.client.getGenerativeModel({ model: embeddingModel });

      const result = await model.batchEmbedContents({
        requests: request.input.map((text) => ({
          content: { role: 'user', parts: [{ text }] },
        })),
      });

      return {
        vectors: result.embeddings.map((e) => e.values),
        provider: this.name,
        model: embeddingModel,
        totalTokens: request.input.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      throw translate(error, this.name);
    }
  }
}
