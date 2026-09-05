import type { AiFeature, AiProviderName } from '@prisma/client';

export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  feature: AiFeature;
  messages: ChatMessageInput[];
  /** Ask the provider for machine-readable output where it supports it. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Prefer the cheap model; used for classification and short rewrites. */
  fast?: boolean;
}

export interface CompletionResponse {
  text: string;
  provider: AiProviderName;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface EmbeddingRequest {
  input: string[];
  feature: AiFeature;
}

export interface EmbeddingResponse {
  vectors: number[][];
  provider: AiProviderName;
  model: string;
  totalTokens: number;
  latencyMs: number;
}

export interface AiProvider {
  readonly name: AiProviderName;
  readonly supportsEmbedding: boolean;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

/** Distinguishes "try the next provider" from "this request was wrong". */
export class AiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly provider?: AiProviderName,
  ) {
    super(message);
    this.name = 'AiError';
  }
}
