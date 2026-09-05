import { AiFeature, AiProviderName, Prisma } from '@prisma/client';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { AnthropicProvider } from './providers/anthropic.provider';
import { GeminiProvider } from './providers/gemini.provider';
import { MockProvider } from './providers/mock.provider';
import { OpenAiProvider } from './providers/openai.provider';
import { AiError } from './types';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from './types';

/**
 * Rough per-million-token pricing, used only to keep the daily budget honest.
 * These drift, so the figure is a guide for the usage dashboard rather than a
 * billing record.
 */
const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  default: { input: 1, output: 3 },
};

const cache = new Map<AiProviderName, AiProvider>();

function build(name: AiProviderName): AiProvider {
  const cached = cache.get(name);
  if (cached) return cached;

  const provider: AiProvider =
    name === AiProviderName.OPENAI
      ? new OpenAiProvider()
      : name === AiProviderName.ANTHROPIC
        ? new AnthropicProvider()
        : name === AiProviderName.GEMINI
          ? new GeminiProvider()
          : new MockProvider();

  cache.set(name, provider);
  return provider;
}

export function resetProviderCache(): void {
  cache.clear();
}

function configuredName(): AiProviderName {
  switch (env.AI_PROVIDER) {
    case 'openai':
      return AiProviderName.OPENAI;
    case 'anthropic':
      return AiProviderName.ANTHROPIC;
    case 'gemini':
      return AiProviderName.GEMINI;
    case 'local':
      return AiProviderName.LOCAL;
    default:
      return AiProviderName.MOCK;
  }
}

/**
 * The order in which providers are tried.
 *
 * The mock provider is always last. That is deliberate: a lesson should degrade
 * to obviously-synthetic output rather than to a 500, but the fallback must
 * never be reachable before every real option has been exhausted, or a
 * misconfigured key would quietly serve placeholder text to a whole institute.
 */
export function providerChain(): AiProviderName[] {
  const primary = configuredName();
  const chain: AiProviderName[] = [primary];

  const alternates: AiProviderName[] = [];
  if (env.OPENAI_API_KEY) alternates.push(AiProviderName.OPENAI);
  if (env.ANTHROPIC_API_KEY) alternates.push(AiProviderName.ANTHROPIC);
  if (env.GOOGLE_API_KEY) alternates.push(AiProviderName.GEMINI);

  for (const alternate of alternates) {
    if (!chain.includes(alternate)) chain.push(alternate);
  }

  if (!chain.includes(AiProviderName.MOCK)) chain.push(AiProviderName.MOCK);
  return chain;
}

async function tokensUsedToday(): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);

  const result = await prisma.aiUsageLog.aggregate({
    where: { createdAt: { gte: since }, success: true },
    _sum: { totalTokens: true },
  });

  return result._sum.totalTokens ?? 0;
}

/**
 * Refuses the call once the day's token budget is spent.
 *
 * A runaway loop against a paid API is the single most expensive failure mode
 * in a product like this, and it is far better to disable AI features for the
 * rest of the day than to discover the spend on an invoice.
 */
async function assertWithinBudget(): Promise<void> {
  if (env.AI_DAILY_TOKEN_BUDGET <= 0) return;

  const used = await tokensUsedToday();
  if (used >= env.AI_DAILY_TOKEN_BUDGET) {
    throw new AiError(
      `The daily AI token budget of ${env.AI_DAILY_TOKEN_BUDGET} is spent. It resets at midnight UTC.`,
      'BUDGET_EXHAUSTED',
      false,
    );
  }
}

interface UsageInput {
  userId?: string | null;
  feature: AiFeature;
  provider: AiProviderName;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  success: boolean;
  errorCode?: string | null;
  requestId?: string | null;
}

async function recordUsage(input: UsageInput): Promise<void> {
  const total = input.promptTokens + input.completionTokens;
  const rate = COST_PER_MILLION.default as { input: number; output: number };
  const cost = (input.promptTokens * rate.input + input.completionTokens * rate.output) / 1_000_000;

  try {
    await prisma.aiUsageLog.create({
      data: {
        userId: input.userId ?? null,
        feature: input.feature,
        provider: input.provider,
        model: input.model,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        totalTokens: total,
        estimatedCostUsd: new Prisma.Decimal(cost.toFixed(6)),
        latencyMs: input.latencyMs,
        success: input.success,
        errorCode: input.errorCode ?? null,
        requestId: input.requestId ?? null,
      },
    });
  } catch (error) {
    // Never let accounting break the feature it is accounting for.
    logger.error({ err: error }, 'failed to write AI usage log');
  }
}

export interface CallContext {
  userId?: string | null;
  requestId?: string | null;
}

/**
 * Runs a completion, failing over down the chain on retryable errors.
 *
 * A non-retryable error — a bad request, a rejected key — stops immediately,
 * because trying the same malformed prompt against three providers just burns
 * three times the money to reach the same conclusion.
 */
export async function complete(
  request: CompletionRequest,
  context: CallContext = {},
): Promise<CompletionResponse> {
  await assertWithinBudget();

  const chain = providerChain();
  let lastError: AiError | null = null;

  for (const name of chain) {
    let provider: AiProvider;

    try {
      provider = build(name);
    } catch (error) {
      lastError = error instanceof AiError ? error : new AiError(String(error), 'INIT', true, name);
      continue;
    }

    const started = Date.now();

    try {
      const response = await provider.complete(request);

      await recordUsage({
        ...context,
        feature: request.feature,
        provider: response.provider,
        model: response.model,
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        latencyMs: response.latencyMs,
        success: true,
      });

      if (name !== chain[0]) {
        logger.warn({ fellBackTo: name, from: chain[0] }, 'AI request fell back to another provider');
      }

      return response;
    } catch (error) {
      const aiError =
        error instanceof AiError ? error : new AiError(String(error), 'UNKNOWN', true, name);

      await recordUsage({
        ...context,
        feature: request.feature,
        provider: name,
        model: (request.fast ? env.AI_FAST_MODEL : env.AI_TEXT_MODEL) ?? 'unknown',
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - started,
        success: false,
        errorCode: aiError.code,
      });

      lastError = aiError;

      if (!aiError.retryable) {
        logger.error({ provider: name, code: aiError.code }, 'AI request failed and will not retry');
        throw aiError;
      }

      logger.warn({ provider: name, code: aiError.code }, 'AI provider failed, trying the next');
    }
  }

  throw lastError ?? new AiError('No AI provider was reachable.', 'NO_PROVIDER', false);
}

export async function embed(
  request: EmbeddingRequest,
  context: CallContext = {},
): Promise<EmbeddingResponse> {
  await assertWithinBudget();

  const chain = providerChain().filter((name) => {
    try {
      return build(name).supportsEmbedding;
    } catch {
      return false;
    }
  });

  let lastError: AiError | null = null;

  for (const name of chain) {
    try {
      const response = await build(name).embed(request);

      await recordUsage({
        ...context,
        feature: AiFeature.EMBEDDING,
        provider: response.provider,
        model: response.model,
        promptTokens: response.totalTokens,
        completionTokens: 0,
        latencyMs: response.latencyMs,
        success: true,
      });

      return response;
    } catch (error) {
      lastError = error instanceof AiError ? error : new AiError(String(error), 'UNKNOWN', true, name);
      if (!lastError.retryable) throw lastError;
    }
  }

  throw lastError ?? new AiError('No embedding provider was reachable.', 'NO_PROVIDER', false);
}

/** Surfaced by the health endpoint and the admin usage screen. */
export async function usageSummary() {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);

  const [today, byFeature] = await Promise.all([
    prisma.aiUsageLog.aggregate({
      where: { createdAt: { gte: since } },
      _sum: { totalTokens: true, estimatedCostUsd: true },
      _count: { _all: true },
    }),
    prisma.aiUsageLog.groupBy({
      by: ['feature', 'success'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { totalTokens: true },
    }),
  ]);

  const used = today._sum.totalTokens ?? 0;

  return {
    provider: configuredName(),
    chain: providerChain(),
    tokensToday: used,
    dailyBudget: env.AI_DAILY_TOKEN_BUDGET,
    budgetRemaining: Math.max(0, env.AI_DAILY_TOKEN_BUDGET - used),
    estimatedCostUsdToday: Number(today._sum.estimatedCostUsd ?? 0),
    callsToday: today._count._all,
    byFeature,
  };
}
