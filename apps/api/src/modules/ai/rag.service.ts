import { AiFeature, IngestStatus, Prisma } from '@prisma/client';
import { chunkText, type Chunk, estimateTokens } from '../../ai/chunking';
import { retrieve, buildContext, type CandidateChunk, type ScoredChunk } from '../../ai/retrieval';
import { embed } from '../../ai/router';
import { env } from '../../config/env';
import { notFound, unprocessable } from '../../lib/http-error';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { getStorage } from '../../lib/storage';

async function extractText(objectKey: string, mimeType: string): Promise<string | null> {
  const storage = getStorage();
  if (mimeType.startsWith('image/')) return null;
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    // For local driver, we need to read file directly if possible
    try {
      // @ts-ignore - localDriver may have read method
      const local = (storage as any).read ? await (storage as any).read(objectKey) : null;
      if (local) return local.toString('utf-8');
    } catch {}
    return null;
  }
  return null;
}

export interface IngestResult {
  materialId: string;
  status: IngestStatus;
  chunks: number;
  embedded: number;
  skippedReason?: string;
}

export async function ingestMaterial(materialId: string): Promise<IngestResult> {
  const material = await prisma.studyMaterial.findFirst({
    where: { id: materialId, deletedAt: null },
    select: {
      id: true,
      title: true,
      rawText: true,
      type: true,
      files: {
        where: { deletedAt: null },
        select: { objectKey: true, mimeType: true, originalName: true },
      },
    },
  });

  if (!material) throw notFound('Study material');

  await prisma.studyMaterial.update({
    where: { id: materialId },
    data: { ingestStatus: IngestStatus.PROCESSING, ingestError: null },
  });

  try {
    let text = material.rawText ?? '';
    if (!text) {
      for (const file of material.files) {
        const extracted = await extractText(file.objectKey, file.mimeType);
        if (extracted) text += `\n\n${extracted}`;
      }
    }

    if (text.trim().length < 100) {
      await prisma.studyMaterial.update({
        where: { id: materialId },
        data: {
          ingestStatus: IngestStatus.SKIPPED,
          ingestError: 'No extractable text. Scanned images need the OCR path.',
          chunkCount: 0,
        },
      });
      return {
        materialId,
        status: IngestStatus.SKIPPED,
        chunks: 0,
        embedded: 0,
        skippedReason: 'No extractable text was found.',
      };
    }

    const chunks: Chunk[] = chunkText(text, {
      chunkSize: env.RAG_CHUNK_SIZE,
      chunkOverlap: env.RAG_CHUNK_OVERLAP,
      minChunkTokens: 40,
    });

    if (chunks.length === 0) {
      throw new Error('Chunking produced nothing from non-empty text.');
    }

    await prisma.materialChunk.deleteMany({ where: { materialId } });

    const BATCH = 32;
    let embedded = 0;

    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      let vectors: number[][] = [];
      let model = 'none';
      try {
        const response = await embed({
          input: slice.map((c) => c.content),
          feature: AiFeature.EMBEDDING,
        });
        vectors = response.vectors;
        model = response.model;
      } catch (error) {
        logger.error({ err: error, materialId }, 'embedding failed; storing chunks unembedded');
      }

      for (const [offset, chunk] of slice.entries()) {
        const vector = vectors[offset];
        await prisma.materialChunk.create({
          data: {
            materialId,
            chunkIndex: chunk.index,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            pageNumber: chunk.pageNumber,
            sectionTitle: chunk.sectionTitle,
            ...(vector
              ? {
                  embeddingJson: vector as unknown as Prisma.InputJsonValue,
                  embeddingModel: model,
                }
              : {}),
          },
        });
        if (vector) embedded += 1;
      }
    }

    if (env.PGVECTOR_ENABLED && embedded > 0) {
      try {
        await prisma.$executeRawUnsafe(`
          UPDATE material_chunks
             SET embedding = (
                   SELECT array_to_string(ARRAY(
                     SELECT jsonb_array_elements_text("embeddingJson")
                   ), ',')
                 )::vector
           WHERE "materialId" = $1::uuid
             AND "embeddingJson" IS NOT NULL
        `, materialId);
      } catch (error) {
        logger.warn(
          { err: error, materialId },
          'pgvector mirror failed; retrieval will use the JSON fallback',
        );
      }
    }

    await prisma.studyMaterial.update({
      where: { id: materialId },
      data: {
        ingestStatus: IngestStatus.INDEXED,
        chunkCount: chunks.length,
        indexedAt: new Date(),
        ingestError: embedded < chunks.length ? 'Some chunks are not embedded yet.' : null,
      },
    });

    return { materialId, status: IngestStatus.INDEXED, chunks: chunks.length, embedded };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown ingestion error';
    await prisma.studyMaterial.update({
      where: { id: materialId },
      data: { ingestStatus: IngestStatus.FAILED, ingestError: message.slice(0, 500) },
    });
    throw error;
  }
}

export interface RetrievalScope {
  subjectId?: string | undefined;
  topicId?: string | undefined;
  batchId?: string | undefined;
  materialIds?: string[] | undefined;
}

export async function retrievePassages(
  query: string,
  scope: RetrievalScope,
  instituteId: string,
): Promise<{ chunks: ScoredChunk[]; context: string; degraded: boolean }> {
  const where: Prisma.MaterialChunkWhereInput = {
    material: {
      deletedAt: null,
      subject: { instituteId },
      ...(scope.subjectId ? { subjectId: scope.subjectId } : {}),
      ...(scope.topicId ? { topicId: scope.topicId } : {}),
      ...(scope.batchId ? { OR: [{ batchId: scope.batchId }, { batchId: null }] } : {}),
      ...(scope.materialIds ? { id: { in: scope.materialIds } } : {}),
    },
  };

  const rows = await prisma.materialChunk.findMany({
    where,
    take: 600,
    select: {
      id: true,
      content: true,
      chunkIndex: true,
      sectionTitle: true,
      pageNumber: true,
      embeddingJson: true,
      materialId: true,
      material: { select: { title: true, isCurriculumApproved: true } },
    },
  });

  const approved = rows.filter((row) => row.material.isCurriculumApproved);
  const pool = approved.length > 0 ? approved : rows;

  if (pool.length === 0) {
    return { chunks: [], context: '', degraded: true };
  }

  let queryVector: number[] | null = null;
  let degraded = false;

  try {
    const response = await embed({ input: [query], feature: AiFeature.EMBEDDING });
    queryVector = response.vectors[0] ?? null;
  } catch (error) {
    logger.warn({ err: error }, 'query embedding failed; falling back to keyword retrieval');
    degraded = true;
  }

  const candidates: CandidateChunk[] = pool.map((row) => ({
    chunkId: row.id,
    id: row.id,
    materialId: row.materialId,
    materialTitle: row.material.title,
    content: row.content,
    chunkIndex: row.chunkIndex,
    sectionTitle: row.sectionTitle,
    pageNumber: row.pageNumber,
    embedding: Array.isArray(row.embeddingJson) ? (row.embeddingJson as number[]) : null,
  }));

  // Use unified retrieve - pass query string for keyword fallback
  const result = queryVector
    ? retrieve(queryVector, candidates, {
        topK: env.RAG_TOP_K,
        minScore: env.RAG_MIN_SCORE,
        maxPerMaterial: 3,
      })
    : retrieve(query, queryVector, candidates, {
        topK: env.RAG_TOP_K,
        minScore: env.RAG_MIN_SCORE,
        perMaterialLimit: 3,
      });

  if (!result.grounded) {
    return { chunks: [], context: '', degraded: true };
  }

  const contextResult = buildContext(result.chunks, 6000, estimateTokens);
  const contextText = typeof contextResult === 'string' ? contextResult : contextResult.text;

  return {
    chunks: result.chunks,
    context: contextText,
    degraded: degraded || result.chunks.length === 0,
  };
}

export async function reindexPending(instituteId: string, limit = 20) {
  const pending = await prisma.studyMaterial.findMany({
    where: {
      deletedAt: null,
      subject: { instituteId },
      ingestStatus: { in: [IngestStatus.PENDING, IngestStatus.FAILED] },
    },
    take: limit,
    select: { id: true, title: true },
  });

  const results: { id: string; title: string; ok: boolean; detail: string }[] = [];

  for (const material of pending) {
    try {
      const result = await ingestMaterial(material.id);
      results.push({
        id: material.id,
        title: material.title,
        ok: true,
        detail: `${result.chunks} chunks, ${result.embedded} embedded`,
      });
    } catch (error) {
      results.push({
        id: material.id,
        title: material.title,
        ok: false,
        detail: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return { attempted: pending.length, results };
}

export async function indexStatus(instituteId: string) {
  const grouped = await prisma.studyMaterial.groupBy({
    by: ['ingestStatus'],
    where: { deletedAt: null, subject: { instituteId } },
    _count: { _all: true },
    _sum: { chunkCount: true },
  });

  const totals = Object.fromEntries(
    grouped.map((row) => [row.ingestStatus, row._count._all]),
  ) as Record<string, number>;

  return {
    materials: totals,
    totalChunks: grouped.reduce((sum, row) => sum + (row._sum.chunkCount ?? 0), 0),
    pgvectorEnabled: env.PGVECTOR_ENABLED,
    embeddingModel: env.AI_EMBEDDING_MODEL,
    embeddingDimensions: env.AI_EMBEDDING_DIM,
  };
}

export function assertEmbeddingDimension(vector: number[]): void {
  if (vector.length !== env.AI_EMBEDDING_DIM) {
    throw unprocessable(
      `The embedding model returned ${vector.length} dimensions but AI_EMBEDDING_DIM is ${env.AI_EMBEDDING_DIM}. Change one, and migrate the vector column to match.`,
    );
  }
}
