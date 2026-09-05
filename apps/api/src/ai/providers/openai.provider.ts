import { AiProviderName } from '@prisma/client';
import OpenAI from 'openai';
import { env } from '../../config/env';
import { AiError } from '../types';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../types';

export class OpenAiProvider implements AiProvider {
  public readonly name = AiProviderName.OPENAI;
  public readonly supportsEmbedding = true;

  private client: OpenAI;

  constructor() {
    if (!env.OPENAI_API_KEY) {
      throw new AiError('OPENAI_API_KEY is not set.', 'NO_CREDENTIALS', false, this.name);
    }
    this.client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      timeout: env.AI_TIMEOUT_MS,
      maxRetries: 0, // Retries are handled by the router, which also fails over.
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const started = Date.now();
    const model = (request.fast ? env.AI_FAST_MODEL : env.AI_TEXT_MODEL) ?? 'gpt-4o-mini';

    try {
      const response = await this.client.chat.completions.create({
        model,
        messages: request.messages,
        max_tokens: request.maxTokens ?? env.AI_MAX_OUTPUT_TOKENS,
        temperature: request.temperature ?? 0.3,
        ...(request.json ? { response_format: { type: 'json_object' as const } } : {}),
      });

      const text = response.choices[0]?.message?.content ?? '';

      return {
        text,
        provider: this.name,
        model,
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      throw translate(error, this.name);
    }
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const started = Date.now();
    const embeddingModel = env.AI_EMBEDDING_MODEL ?? 'text-embedding-3-small';

    try {
      const response = await this.client.embeddings.create({
        model: embeddingModel,
        input: request.input,
      });

      return {
        vectors: response.data.map((row) => row.embedding),
        provider: this.name,
        model: embeddingModel,
        totalTokens: response.usage?.total_tokens ?? 0,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      throw translate(error, this.name);
    }
  }
}

/**
 * Maps a provider error onto the router's retry decision.
 *
 * The distinction is the whole point: a rate limit or a 503 should fail over to
 * the next provider, while a malformed request or a rejected key should stop
 * immediately rather than replaying the same broken call three more times.
 */
export function translate(error: unknown, provider: AiProviderName): AiError {
  const status = (error as { status?: number })?.status;
  const message = error instanceof Error ? error.message : 'Unknown provider error';

  if (status === 401 || status === 403) {
    return new AiError('The AI provider rejected the credentials.', 'AUTH', false, provider);
  }
  if (status === 400 || status === 422) {
    return new AiError(message, 'BAD_REQUEST', false, provider);
  }
  if (status === 429) {
    return new AiError('The AI provider is rate limiting.', 'RATE_LIMIT', true, provider);
  }
  if (status !== undefined && status >= 500) {
    return new AiError('The AI provider is unavailable.', 'UPSTREAM', true, provider);
  }

  return new AiError(message, 'NETWORK', true, provider);
}
