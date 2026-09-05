/**
 * Retrieval scoring - Polished & Backward Compatible
 * Supports both legacy (query string + vector) and new (embedding-only) APIs
 * Ensures grounding guarantee: if nothing relevant, return refusal, don't call model
 */

export interface ScoredChunk {
  chunkId: string;
  id: string; // alias for chunkId for legacy compatibility
  materialId: string;
  materialTitle?: string | null;
  content: string;
  score: number;
  sectionTitle: string | null;
  pageNumber: number | null;
  chunkIndex?: number | null;
}

export interface CandidateChunk {
  chunkId: string;
  id: string; // alias
  materialId: string;
  materialTitle?: string | null;
  content: string;
  embedding: number[] | null;
  sectionTitle: string | null;
  pageNumber: number | null;
  chunkIndex?: number | null;
}

export interface RetrievalOptions {
  topK: number;
  minScore: number;
  diversityLambda?: number;
  maxPerMaterial?: number;
  // Legacy options
  maxContextTokens?: number;
  perMaterialLimit?: number;
}

export const DEFAULT_RETRIEVAL: RetrievalOptions = {
  topK: 6,
  minScore: 0.25,
  diversityLambda: 0.5,
  maxPerMaterial: 4,
  maxContextTokens: 6000,
  perMaterialLimit: 4,
};

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Simple keyword fallback scoring when no embedding available
 * Uses TF-like scoring on word overlap
 */
function keywordScore(query: string, content: string): number {
  if (!query || !content) return 0;
  const qWords = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const cLower = content.toLowerCase();
  if (qWords.length === 0) return 0;
  let matches = 0;
  for (const w of qWords) {
    if (cLower.includes(w)) matches += 1;
  }
  return matches / qWords.length;
}

export type RetrievalResult =
  | { grounded: true; chunks: ScoredChunk[]; topScore: number }
  | { grounded: false; reason: string; bestScore: number };

export function selectDiverse(
  candidates: { candidate: CandidateChunk; score: number }[],
  queryTopK: number,
  lambda: number,
): { candidate: CandidateChunk; score: number }[] {
  const pool = [...candidates].sort((a, b) => b.score - a.score);
  const selected: { candidate: CandidateChunk; score: number }[] = [];
  while (selected.length < queryTopK && pool.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const entry = pool[i] as { candidate: CandidateChunk; score: number };
      const maxOverlap = selected.reduce(
        (worst, chosen) =>
          Math.max(worst, cosineSimilarity(entry.candidate.embedding ?? [], chosen.candidate.embedding ?? [])),
        0,
      );
      const value = lambda * entry.score - (1 - lambda) * maxOverlap;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    selected.push(pool[bestIndex] as { candidate: CandidateChunk; score: number });
    pool.splice(bestIndex, 1);
  }
  return selected;
}

/**
 * Unified retrieve function - handles both legacy and new signatures
 * Legacy: retrieve(queryString, queryVector, candidates, options)
 * New: retrieve(queryEmbedding, candidates, options)
 */
export function retrieve(
  queryOrEmbedding: string | number[],
  queryVectorOrCandidates: number[] | null | CandidateChunk[],
  candidatesOrOptions?: CandidateChunk[] | RetrievalOptions,
  options?: RetrievalOptions,
): RetrievalResult {
  let queryText = '';
  let queryEmbedding: number[] | null = null;
  let candidates: CandidateChunk[] = [];
  let opts: RetrievalOptions = DEFAULT_RETRIEVAL;

  // Detect signature
  if (typeof queryOrEmbedding === 'string') {
    // Legacy: (query, vector, candidates, options)
    queryText = queryOrEmbedding;
    queryEmbedding = queryVectorOrCandidates as number[] | null;
    candidates = (candidatesOrOptions as CandidateChunk[]) ?? [];
    opts = { ...DEFAULT_RETRIEVAL, ...(options ?? {}) };
  } else if (Array.isArray(queryOrEmbedding) && typeof queryOrEmbedding[0] === 'number') {
    // Could be new API: (embedding, candidates, options) OR legacy where second arg is candidates
    if (Array.isArray(queryVectorOrCandidates) && queryVectorOrCandidates.length > 0 && typeof (queryVectorOrCandidates as any)[0] === 'object') {
      // New API: first is embedding, second is candidates
      queryEmbedding = queryOrEmbedding as number[];
      candidates = queryVectorOrCandidates as CandidateChunk[];
      opts = { ...DEFAULT_RETRIEVAL, ...(candidatesOrOptions as RetrievalOptions ?? {}) };
    } else {
      // Also new API but second param is candidates
      queryEmbedding = queryOrEmbedding as number[];
      candidates = queryVectorOrCandidates as unknown as CandidateChunk[];
      opts = { ...DEFAULT_RETRIEVAL, ...(candidatesOrOptions as RetrievalOptions ?? {}) };
    }
  } else {
    // Fallback
    candidates = [];
  }

  // Normalize candidates to have both id and chunkId
  const normalized: CandidateChunk[] = candidates.map((c: any) => ({
    chunkId: c.chunkId ?? c.id ?? '',
    id: c.id ?? c.chunkId ?? '',
    materialId: c.materialId ?? '',
    materialTitle: c.materialTitle ?? null,
    content: c.content ?? '',
    embedding: c.embedding ?? null,
    sectionTitle: c.sectionTitle ?? null,
    pageNumber: c.pageNumber ?? null,
    chunkIndex: c.chunkIndex ?? null,
  }));

  if (normalized.length === 0) {
    return {
      grounded: false,
      reason: 'No teacher material has been indexed for this topic yet.',
      bestScore: 0,
    };
  }

  const scored = normalized.map((candidate) => {
    let score = 0;
    if (queryEmbedding && candidate.embedding) {
      score = cosineSimilarity(queryEmbedding, candidate.embedding);
    } else if (queryText) {
      // keyword fallback
      score = keywordScore(queryText, candidate.content);
      // If we have embedding but queryText also, try embedding if available
      if (queryEmbedding && candidate.embedding) {
        score = Math.max(score, cosineSimilarity(queryEmbedding, candidate.embedding));
      } else if (queryVectorOrCandidates && Array.isArray(queryVectorOrCandidates) && candidate.embedding) {
        // Legacy second arg might be vector
        const vec = queryVectorOrCandidates as number[];
        if (vec && vec.length > 0 && typeof vec[0] === 'number') {
          score = Math.max(score, cosineSimilarity(vec, candidate.embedding));
        }
      }
    } else if (queryEmbedding && !candidate.embedding) {
      // No embedding on candidate, can't score high
      score = 0;
    }
    return { candidate, score };
  });

  const bestScore = scored.reduce((best, entry) => Math.max(best, entry.score), 0);
  const relevant = scored.filter((entry) => entry.score >= (opts.minScore ?? 0.25));

  if (relevant.length === 0) {
    return {
      grounded: false,
      reason: 'Nothing in the uploaded material is close enough to this question to answer from.',
      bestScore: Math.round(bestScore * 1000) / 1000,
    };
  }

  const lambda = opts.diversityLambda ?? 0.5;
  const topK = opts.topK ?? 6;
  const diverse = selectDiverse(relevant, topK * 2, lambda);

  const perMaterial = new Map<string, number>();
  const maxPer = opts.maxPerMaterial ?? opts.perMaterialLimit ?? 4;
  const chunks: ScoredChunk[] = [];

  for (const entry of diverse) {
    const used = perMaterial.get(entry.candidate.materialId) ?? 0;
    if (used >= maxPer) continue;
    perMaterial.set(entry.candidate.materialId, used + 1);
    chunks.push({
      chunkId: entry.candidate.chunkId,
      id: entry.candidate.id,
      materialId: entry.candidate.materialId,
      materialTitle: entry.candidate.materialTitle ?? null,
      content: entry.candidate.content,
      score: Math.round(entry.score * 1000) / 1000,
      sectionTitle: entry.candidate.sectionTitle,
      pageNumber: entry.candidate.pageNumber,
      chunkIndex: entry.candidate.chunkIndex ?? null,
    });
    if (chunks.length >= topK) break;
  }

  return {
    grounded: true,
    chunks,
    topScore: Math.round(bestScore * 1000) / 1000,
  };
}

/**
 * buildContext - supports both signatures
 * Old: buildContext(chunks) -> string
 * New: buildContext(chunks, maxTokens, estimate) -> { text, usedChunkIds }
 */
export function buildContext(
  chunks: ScoredChunk[],
  maxTokens?: number,
  estimate?: (text: string) => number,
): string | { text: string; usedChunkIds: string[] } {
  if (maxTokens === undefined || estimate === undefined) {
    // Legacy simple version
    return chunks
      .map((chunk, idx) => {
        const label = chunk.sectionTitle ? `[${idx + 1}] ${chunk.sectionTitle}` : `[${idx + 1}]`;
        return `${label}\n${chunk.content}`;
      })
      .join('\n\n');
  }

  // New version with budget
  const parts: string[] = [];
  const usedChunkIds: string[] = [];
  let budget = maxTokens;

  for (const [index, chunk] of chunks.entries()) {
    const label = chunk.sectionTitle ? `[${index + 1}] ${chunk.sectionTitle}` : `[${index + 1}]`;
    const block = `${label}\n${chunk.content}`;
    const cost = estimate(block);
    if (cost > budget) {
      if (parts.length === 0) {
        const ratio = Math.max(0.1, budget / cost);
        const cut = Math.floor(chunk.content.length * ratio);
        parts.push(`${label}\n${chunk.content.slice(0, cut)}...`);
        usedChunkIds.push(chunk.chunkId);
      }
      break;
    }
    parts.push(block);
    usedChunkIds.push(chunk.chunkId);
    budget -= cost;
  }

  return { text: parts.join('\n\n'), usedChunkIds };
}

export function checkGrounding(
  citedIndices: number[],
  suppliedCount: number,
): { ok: boolean; reason?: string; validIndices: number[] } {
  const valid = citedIndices.filter((i) => Number.isInteger(i) && i >= 1 && i <= suppliedCount);
  const invalid = citedIndices.filter((i) => !valid.includes(i));
  if (citedIndices.length === 0) {
    return {
      ok: false,
      reason: 'The generated content cites no source passage.',
      validIndices: [],
    };
  }
  if (invalid.length > 0) {
    return {
      ok: false,
      reason: `Cites passage(s) ${invalid.join(', ')}, which were not supplied.`,
      validIndices: valid,
    };
  }
  return { ok: true, validIndices: valid };
}
