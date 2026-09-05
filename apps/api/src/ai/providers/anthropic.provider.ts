import Anthropic from '@anthropic-ai/sdk';
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

export class AnthropicProvider implements AiProvider {
  public readonly name = AiProviderName.ANTHROPIC;
  /** Anthropic has no embedding endpoint; the router sends those elsewhere. */
  public readonly supportsEmbedding = false;

  private client: Anthropic;

  constructor() {
    if (!env.ANTHROPIC_API_KEY) {
      throw new AiError('ANTHROPIC_API_KEY is not set.', 'NO_CREDENTIALS', false, this.name);
    }
    this.client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      timeout: env.AI_TIMEOUT_MS,
      maxRetries: 0,
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const started = Date.now();
    const model = (request.fast ? env.AI_FAST_MODEL : env.AI_TEXT_MODEL) ?? 'claude-3-5-sonnet-20240620';

    // The system prompt is a top-level parameter here rather than a message.
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const turns = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: request.maxTokens ?? env.AI_MAX_OUTPUT_TOKENS,
        temperature: request.temperature ?? 0.3,
        ...(system ? { system } : {}),
        messages: turns.length > 0 ? turns : [{ role: 'user', content: 'Continue.' }],
      });

      const text = response.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');

      return {
        text,
        provider: this.name,
        model,
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      throw translate(error, this.name);
    }
  }

  async embed(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new AiError(
      'This provider does not produce embeddings. Point AI_EMBEDDING_MODEL at a provider that does.',
      'UNSUPPORTED',
      false,
      this.name,
    );
  }
}
