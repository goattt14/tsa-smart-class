import { AuditAction, Role } from '@prisma/client';
import type { Request, Response } from 'express';
import { created, ok } from '../../lib/api-response';
import { recordAudit } from '../../lib/audit';
import { unprocessable } from '../../lib/http-error';
import { requireContext } from '../../middleware/authorize';
import {
  createHomeworkSchema,
  gradeSubmissionSchema,
  listHomeworkSchema,
  submitHomeworkSchema,
} from './homework.schemas';
import * as service from './homework.service';

export async function listHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const items = await service.listHomework(auth, listHomeworkSchema.parse(req.query));
  return ok(res, { assignments: items });
}

export async function createHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = createHomeworkSchema.parse(req.body);
  const assignment = await service.createHomework(auth, input);

  await recordAudit(req, {
    action: AuditAction.SETTINGS_UPDATED,
    entityType: 'Assignment',
    entityId: assignment.id,
    summary: `Set ${assignment.kind.toLowerCase()} "${assignment.title}", due ${assignment.dueAt.toISOString()}`,
  });

  return created(res, { assignment });
}

export async function submitHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = submitHomeworkSchema.parse(req.body);
  const submission = await service.submitHomework(
    auth,
    req.params.assignmentId ?? '',
    input.contentText,
    input.asDraft,
  );
  return created(res, { submission });
}

export async function queueHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const queue = await service.submissionQueue(auth, req.params.assignmentId ?? '');
  return ok(res, queue);
}

export async function gradeHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const input = gradeSubmissionSchema.parse(req.body);
  const graded = await service.gradeSubmission(auth, req.params.submissionId ?? '', input);

  await recordAudit(req, {
    action: AuditAction.MARKS_UPDATED,
    entityType: 'AssignmentSubmission',
    entityId: graded.id,
    summary: `Marked ${graded.rawMarks}${graded.latePenaltyApplied > 0 ? `, less a ${graded.latePenaltyApplied} late penalty` : ''}`,
    after: graded,
  });

  return ok(res, { submission: graded });
}

export async function studentHandler(req: Request, res: Response) {
  const auth = requireContext(req);
  const requested = typeof req.query.studentId === 'string' ? req.query.studentId : null;

  const studentId = auth.role === Role.STUDENT ? auth.profileId : requested;
  if (!studentId) throw unprocessable('Pass a studentId, or call this as a student.');

  const record = await service.studentHomework(auth, studentId);
  return ok(res, record);
}
