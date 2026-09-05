import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(120).optional(),
  sort: z.string().trim().max(60).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

export function toSkipTake(input: { page: number; pageSize: number }) {
  return { skip: (input.page - 1) * input.pageSize, take: input.pageSize };
}

/**
 * Only fields on this allow-list may be sorted, otherwise a caller could order
 * by an arbitrary column and probe data they cannot read.
 */
export function safeOrderBy<T extends string>(
  requested: string | undefined,
  allowed: readonly T[],
  fallback: T,
  order: 'asc' | 'desc',
): Record<string, 'asc' | 'desc'> {
  const field = allowed.includes(requested as T) ? (requested as T) : fallback;
  return { [field]: order };
}
