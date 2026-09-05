import type { Response } from 'express';

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export function ok<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({ success: true, data });
}

export function created<T>(res: Response, data: T): Response {
  return res.status(201).json({ success: true, data });
}

export function noContent(res: Response): Response {
  return res.status(204).send();
}

export function paginated<T>(res: Response, items: T[], meta: PageMeta): Response {
  res.setHeader('X-Total-Count', String(meta.total));
  return res.status(200).json({ success: true, data: items, meta });
}

export function buildPageMeta(page: number, pageSize: number, total: number): PageMeta {
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}
