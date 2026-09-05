import { AuditAction } from '@prisma/client';
import type { Request, Response } from 'express';
import { created, noContent, ok, paginated } from '../../lib/api-response';
import { recordAudit } from '../../lib/audit';
import { requireContext } from '../../middleware/authorize';
import {
  assignTeacherSchema,
  createBatchSchema,
  createClassSchema,
  createSubjectSchema,
  enrollSchema,
  listQuerySchema,
  updateBatchSchema,
  updateClassSchema,
  updateEnrollmentSchema,
  updateSubjectSchema,
} from './academics.schemas';
import * as service from './academics.service';

// ----------------------------------------------------------------- classes --

export async function listClassesHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = listQuerySchema.parse(req.query);
  const result = await service.listClasses(auth, query);
  return paginated(res, result.items, result.meta);
}

export async function createClassHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = createClassSchema.parse(req.body);
  const record = await service.createClass(auth, input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'ClassGroup',
    entityId: record.id,
    summary: `Created class ${record.name} (${record.code}) for ${record.academicYear}`,
    after: record,
  });

  return created(res, { class: record });
}

export async function updateClassHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = updateClassSchema.parse(req.body);
  const { before, after } = await service.updateClass(auth, req.params.classId ?? '', input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'ClassGroup',
    entityId: after.id,
    summary: `Updated class ${after.name}`,
    before,
    after,
  });

  return ok(res, { class: after });
}

export async function deleteClassHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const record = await service.deleteClass(auth, req.params.classId ?? '');

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'ClassGroup',
    entityId: record.id,
    summary: `Archived class ${record.name}`,
    before: record,
  });

  return noContent(res);
}

// ----------------------------------------------------------------- batches --

export async function listBatchesHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = listQuerySchema.parse(req.query);
  const result = await service.listBatches(auth, query);
  return paginated(res, result.items, result.meta);
}

export async function getBatchHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const batch = await service.getBatch(auth, req.params.batchId ?? '');
  return ok(res, { batch });
}

export async function createBatchHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = createBatchSchema.parse(req.body);
  const record = await service.createBatch(auth, input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'Batch',
    entityId: record.id,
    summary: `Created batch ${record.name} (${record.code})`,
    after: record,
  });

  return created(res, { batch: record });
}

export async function updateBatchHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = updateBatchSchema.parse(req.body);
  const { before, after } = await service.updateBatch(auth, req.params.batchId ?? '', input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'Batch',
    entityId: after.id,
    summary: `Updated batch ${after.name}`,
    before,
    after,
  });

  return ok(res, { batch: after });
}

// ---------------------------------------------------------------- subjects --

export async function listSubjectsHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const query = listQuerySchema.parse(req.query);
  const result = await service.listSubjects(auth, query);
  return paginated(res, result.items, result.meta);
}

export async function createSubjectHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = createSubjectSchema.parse(req.body);
  const record = await service.createSubject(auth, input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'Subject',
    entityId: record.id,
    summary: `Created subject ${record.name} (${record.code})`,
    after: record,
  });

  return created(res, { subject: record });
}

export async function updateSubjectHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = updateSubjectSchema.parse(req.body);
  const { before, after } = await service.updateSubject(auth, req.params.subjectId ?? '', input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'Subject',
    entityId: after.id,
    summary: `Updated subject ${after.name}`,
    before,
    after,
  });

  return ok(res, { subject: after });
}

// ------------------------------------------------------------- enrollments --

export async function enrollHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = enrollSchema.parse(req.body);
  const batchId = req.params.batchId ?? '';

  const result = await service.enrollStudents(
    auth,
    batchId,
    input.studentIds,
    input.rollNumberPrefix,
  );

  await recordAudit(req, {
    action: AuditAction.USER_UPDATED,
    entityType: 'Batch',
    entityId: batchId,
    summary: `Enrolled ${result.enrolled.length} student(s); ${result.skipped.length} already present`,
    after: { enrolled: result.enrolled.length },
  });

  return created(res, result);
}

export async function updateEnrollmentHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = updateEnrollmentSchema.parse(req.body);
  const { before, after } = await service.updateEnrollment(
    auth,
    req.params.enrollmentId ?? '',
    input,
  );

  await recordAudit(req, {
    action: AuditAction.USER_UPDATED,
    entityType: 'Enrollment',
    entityId: after.id,
    summary: `Enrollment status ${before.status} -> ${after.status}`,
    before,
    after,
  });

  return ok(res, { enrollment: after });
}

// ------------------------------------------------------ teacher assignments --

export async function assignTeacherHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = assignTeacherSchema.parse(req.body);
  const batchId = req.params.batchId ?? '';

  const record = await service.assignTeacher(
    auth,
    batchId,
    input.teacherId,
    input.subjectId,
    input.isPrimary,
  );

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'TeacherAssignment',
    entityId: record.id,
    summary: `Assigned ${record.teacher.user.firstName} ${record.teacher.user.lastName} to ${record.subject.name}`,
    after: record,
  });

  return created(res, { assignment: record });
}

export async function removeAssignmentHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const record = await service.removeAssignment(auth, req.params.assignmentId ?? '');

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'TeacherAssignment',
    entityId: record.id,
    summary: 'Removed a teacher assignment',
    before: record,
  });

  return noContent(res);
}

export async function overviewHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const overview = await service.academicOverview(auth);
  return ok(res, overview);
}
