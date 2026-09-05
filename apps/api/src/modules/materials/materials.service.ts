import { IngestStatus, MaterialType, Prisma, Role, Visibility } from '@prisma/client';
import { buildPageMeta } from '../../lib/api-response';
import { forbidden, notFound, unprocessable } from '../../lib/http-error';
import { safeOrderBy, toSkipTake } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import { batchVisibilityFilter } from '../../lib/scope';
import { buildObjectKey, getStorage } from '../../lib/storage';
import { nowInZone } from '../../lib/time';
import type { AuthContext } from '../../types/express';

const SORTS = ['createdAt', 'title', 'downloadCount'] as const;

/**
 * Who may see a piece of material.
 *
 * PRIVATE is the teacher's own drafting space. BATCH is the default and follows
 * batch membership, so a student sees material for the batches they are
 * enrolled in and nothing else. INSTITUTE is open to every signed-in member.
 */
export function materialVisibilityFilter(auth: AuthContext): Prisma.StudyMaterialWhereInput {
  const base: Prisma.StudyMaterialWhereInput = {
    deletedAt: null,
    subject: { instituteId: auth.instituteId },
  };

  if (auth.role === Role.ADMIN) return base;

  if (auth.role === Role.TEACHER) {
    return {
      ...base,
      OR: [
        { uploadedById: auth.userId },
        { visibility: Visibility.INSTITUTE },
        { visibility: { in: [Visibility.BATCH, Visibility.CLASS] }, batch: batchVisibilityFilter(auth) },
        { batchId: null, visibility: { not: Visibility.PRIVATE } },
      ],
    };
  }

  // Students, parents and management never see PRIVATE drafts.
  return {
    ...base,
    OR: [
      { visibility: Visibility.INSTITUTE },
      { visibility: { in: [Visibility.BATCH, Visibility.CLASS] }, batch: batchVisibilityFilter(auth) },
    ],
  };
}

export async function listMaterials(
  auth: AuthContext,
  args: {
    page: number;
    pageSize: number;
    search?: string | undefined;
    sort?: string | undefined;
    order: 'asc' | 'desc';
    batchId?: string | undefined;
    subjectId?: string | undefined;
    topicId?: string | undefined;
    type?: MaterialType | undefined;
  },
) {
  const where: Prisma.StudyMaterialWhereInput = {
    AND: [
      materialVisibilityFilter(auth),
      ...(args.batchId ? [{ batchId: args.batchId }] : []),
      ...(args.subjectId ? [{ subjectId: args.subjectId }] : []),
      ...(args.topicId ? [{ topicId: args.topicId }] : []),
      ...(args.type ? [{ type: args.type }] : []),
      ...(args.search
        ? [
            {
              OR: [
                { title: { contains: args.search, mode: 'insensitive' as const } },
                { description: { contains: args.search, mode: 'insensitive' as const } },
              ],
            },
          ]
        : []),
    ],
  };

  const { skip, take } = toSkipTake(args);

  const [items, total] = await Promise.all([
    prisma.studyMaterial.findMany({
      where,
      orderBy: safeOrderBy(args.sort, SORTS, 'createdAt', args.order === 'asc' ? 'asc' : 'desc'),
      skip,
      take,
      select: {
        id: true,
        title: true,
        description: true,
        type: true,
        visibility: true,
        externalUrl: true,
        isCurriculumApproved: true,
        ingestStatus: true,
        chunkCount: true,
        downloadCount: true,
        createdAt: true,
        subject: { select: { id: true, name: true, colorHex: true } },
        batch: { select: { id: true, name: true } },
        topic: { select: { id: true, name: true } },
        uploadedBy: { select: { id: true, firstName: true, lastName: true } },
        files: {
          where: { deletedAt: null },
          select: { id: true, originalName: true, mimeType: true, sizeBytes: true },
        },
      },
    }),
    prisma.studyMaterial.count({ where }),
  ]);

  return { items, meta: buildPageMeta(args.page, args.pageSize, total) };
}

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export async function createMaterial(
  auth: AuthContext,
  input: {
    title: string;
    description?: string | undefined;
    subjectId: string;
    batchId?: string | undefined;
    topicId?: string | undefined;
    type: MaterialType;
    externalUrl?: string | undefined;
    visibility: Visibility;
    isCurriculumApproved: boolean;
    rawText?: string | undefined;
  },
  files: UploadedFile[],
) {
  const subject = await prisma.subject.findFirst({
    where: { id: input.subjectId, instituteId: auth.instituteId, deletedAt: null },
    select: { id: true },
  });
  if (!subject) throw notFound('Subject');

  if (input.batchId) {
    const batch = await prisma.batch.findFirst({
      where: { AND: [{ id: input.batchId }, batchVisibilityFilter(auth)] },
      select: { id: true },
    });
    if (!batch) throw forbidden('You are not assigned to that batch.');
  }

  const needsPayload = input.type !== MaterialType.LINK && input.type !== MaterialType.TEXT;
  if (needsPayload && files.length === 0) {
    throw unprocessable(`A ${input.type} material needs at least one file.`);
  }
  if (input.type === MaterialType.LINK && !input.externalUrl) {
    throw unprocessable('A link material needs an external URL.');
  }
  if (input.type === MaterialType.TEXT && !input.rawText) {
    throw unprocessable('A text material needs its content.');
  }

  const teacherId = auth.role === Role.TEACHER ? auth.profileId : null;
  const storage = getStorage();
  const { date } = nowInZone(process.env.TZ ?? 'Asia/Kolkata');

  // The rows and the objects are written together, and the objects are cleaned
  // up if the transaction fails, so a failed upload cannot leave a material
  // pointing at nothing or a bucket full of unreferenced blobs.
  const stored: { key: string }[] = [];

  try {
    const material = await prisma.$transaction(async (tx) => {
      const record = await tx.studyMaterial.create({
        data: {
          subjectId: input.subjectId,
          batchId: input.batchId ?? null,
          topicId: input.topicId ?? null,
          teacherId,
          uploadedById: auth.userId,
          title: input.title,
          description: input.description || null,
          type: input.type,
          externalUrl: input.externalUrl || null,
          rawText: input.rawText || null,
          visibility: input.visibility,
          isCurriculumApproved: input.isCurriculumApproved,
          // Phase 4 picks these up, chunks them and writes the embeddings.
          ingestStatus:
            input.type === MaterialType.LINK ? IngestStatus.SKIPPED : IngestStatus.PENDING,
        },
        select: { id: true },
      });

      for (const file of files) {
        const key = buildObjectKey('material', file.originalname, date);
        const object = await storage.put(key, file.buffer, file.mimetype);
        stored.push({ key });

        await tx.fileAsset.create({
          data: {
            bucket: object.bucket,
            objectKey: object.objectKey,
            originalName: file.originalname,
            mimeType: file.mimetype,
            sizeBytes: object.sizeBytes,
            checksum: object.checksum,
            uploadedById: auth.userId,
            studyMaterialId: record.id,
          },
        });
      }

      return record;
    });

    return material;
  } catch (error) {
    for (const object of stored) {
      await storage.remove(object.key).catch(() => undefined);
    }
    throw error;
  }
}

export async function getMaterial(auth: AuthContext, materialId: string) {
  const material = await prisma.studyMaterial.findFirst({
    where: { AND: [{ id: materialId }, materialVisibilityFilter(auth)] },
    select: {
      id: true,
      title: true,
      description: true,
      type: true,
      visibility: true,
      externalUrl: true,
      rawText: true,
      isCurriculumApproved: true,
      ingestStatus: true,
      ingestError: true,
      chunkCount: true,
      indexedAt: true,
      downloadCount: true,
      createdAt: true,
      subject: { select: { id: true, name: true } },
      batch: { select: { id: true, name: true } },
      topic: { select: { id: true, name: true } },
      uploadedBy: { select: { id: true, firstName: true, lastName: true } },
      files: {
        where: { deletedAt: null },
        select: {
          id: true,
          objectKey: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
        },
      },
    },
  });

  if (!material) throw notFound('Study material');
  return material;
}

/** Issues a short-lived signed URL and counts the download. */
export async function getDownloadUrl(auth: AuthContext, materialId: string, fileId: string) {
  const material = await prisma.studyMaterial.findFirst({
    where: { AND: [{ id: materialId }, materialVisibilityFilter(auth)] },
    select: { id: true },
  });

  if (!material) throw notFound('Study material');

  const file = await prisma.fileAsset.findFirst({
    where: { id: fileId, studyMaterialId: materialId, deletedAt: null },
    select: { objectKey: true, originalName: true, mimeType: true },
  });

  if (!file) throw notFound('File');

  const url = await getStorage().signedUrl(file.objectKey, file.originalName);

  await prisma.studyMaterial.update({
    where: { id: materialId },
    data: { downloadCount: { increment: 1 } },
  });

  return { url, originalName: file.originalName, mimeType: file.mimeType };
}

export async function updateMaterial(
  auth: AuthContext,
  materialId: string,
  input: {
    title?: string | undefined;
    description?: string | null | undefined;
    topicId?: string | null | undefined;
    visibility?: Visibility | undefined;
    isCurriculumApproved?: boolean | undefined;
  },
) {
  const existing = await prisma.studyMaterial.findFirst({
    where: { id: materialId, deletedAt: null, subject: { instituteId: auth.instituteId } },
    select: { id: true, title: true, uploadedById: true, visibility: true },
  });

  if (!existing) throw notFound('Study material');

  if (auth.role === Role.TEACHER && existing.uploadedById !== auth.userId) {
    throw forbidden('You can only edit material you uploaded.');
  }

  const after = await prisma.studyMaterial.update({
    where: { id: materialId },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.topicId !== undefined ? { topicId: input.topicId } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.isCurriculumApproved !== undefined
        ? { isCurriculumApproved: input.isCurriculumApproved }
        : {}),
    },
  });

  return { before: existing, after };
}

/**
 * Soft delete. The objects stay in the bucket because a Phase 4 RAG answer may
 * already cite this material, and a citation pointing at a hole is worse than
 * a few megabytes of retained storage.
 */
export async function deleteMaterial(auth: AuthContext, materialId: string) {
  const existing = await prisma.studyMaterial.findFirst({
    where: { id: materialId, deletedAt: null, subject: { instituteId: auth.instituteId } },
    select: { id: true, title: true, uploadedById: true },
  });

  if (!existing) throw notFound('Study material');

  if (auth.role === Role.TEACHER && existing.uploadedById !== auth.userId) {
    throw forbidden('You can only delete material you uploaded.');
  }

  const now = new Date();

  await prisma.$transaction([
    prisma.studyMaterial.update({ where: { id: materialId }, data: { deletedAt: now } }),
    prisma.fileAsset.updateMany({
      where: { studyMaterialId: materialId },
      data: { deletedAt: now },
    }),
  ]);

  return existing;
}
