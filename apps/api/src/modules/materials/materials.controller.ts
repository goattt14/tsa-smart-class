import { AuditAction } from '@prisma/client';
import type { Request, Response } from 'express';
import { created, noContent, ok, paginated } from '../../lib/api-response';
import { recordAudit } from '../../lib/audit';
import { requireContext } from '../../middleware/authorize';
import {
  createMaterialSchema,
  listMaterialsSchema,
  updateMaterialSchema,
} from './materials.schemas';
import * as service from './materials.service';

export async function listHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = listMaterialsSchema.parse(req.query);
  const result = await service.listMaterials(auth, query);
  return paginated(res, result.items, result.meta);
}

export async function createHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = createMaterialSchema.parse(req.body);
  const files = (req.files as service.UploadedFile[] | undefined) ?? [];

  const material = await service.createMaterial(auth, input, files);

  await recordAudit(req, {
    action: AuditAction.MATERIAL_UPLOADED,
    entityType: 'StudyMaterial',
    entityId: material.id,
    summary: `Uploaded "${input.title}" (${input.type}) with ${files.length} file(s)`,
    after: { title: input.title, type: input.type, visibility: input.visibility },
  });

  return created(res, { materialId: material.id });
}

export async function getHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const material = await service.getMaterial(auth, req.params.materialId ?? '');
  return ok(res, { material });
}

export async function downloadHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const result = await service.getDownloadUrl(
    auth,
    req.params.materialId ?? '',
    req.params.fileId ?? '',
  );
  return ok(res, result);
}

export async function updateHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = updateMaterialSchema.parse(req.body);
  const { before, after } = await service.updateMaterial(
    auth,
    req.params.materialId ?? '',
    input,
  );

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'StudyMaterial',
    entityId: after.id,
    summary: `Updated material "${after.title}"`,
    before,
    after,
  });

  return ok(res, { material: after });
}

export async function deleteHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const material = await service.deleteMaterial(auth, req.params.materialId ?? '');

  await recordAudit(req, {
    action: AuditAction.MATERIAL_DELETED,
    entityType: 'StudyMaterial',
    entityId: material.id,
    summary: `Deleted material "${material.title}"`,
    before: material,
  });

  return noContent(res);
}
