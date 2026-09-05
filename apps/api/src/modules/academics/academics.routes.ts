import { Router } from 'express';
import { asyncHandler } from '../../middleware/async-handler';
import { requireAuth } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import * as controller from './academics.controller';

const router = Router();

router.use(requireAuth);

// Aggregate counts only: this is the endpoint MANAGEMENT is expected to use.
router.get('/overview', requirePermission('analytics.aggregate'), asyncHandler(controller.overviewHandler));

// --- classes ---------------------------------------------------------------
router.get('/classes', requirePermission('classes.read'), asyncHandler(controller.listClassesHandler));
router.post('/classes', requirePermission('classes.manage'), asyncHandler(controller.createClassHandler));
router.patch('/classes/:classId', requirePermission('classes.manage'), asyncHandler(controller.updateClassHandler));
router.delete('/classes/:classId', requirePermission('classes.manage'), asyncHandler(controller.deleteClassHandler));

// --- batches ---------------------------------------------------------------
router.get('/batches', requirePermission('batches.read'), asyncHandler(controller.listBatchesHandler));
router.post('/batches', requirePermission('batches.manage'), asyncHandler(controller.createBatchHandler));
router.get('/batches/:batchId', requirePermission('batches.read'), asyncHandler(controller.getBatchHandler));
router.patch('/batches/:batchId', requirePermission('batches.manage'), asyncHandler(controller.updateBatchHandler));

router.post('/batches/:batchId/enrollments', requirePermission('enrollments.manage'), asyncHandler(controller.enrollHandler));
router.post('/batches/:batchId/teachers', requirePermission('assignments.teacher.manage'), asyncHandler(controller.assignTeacherHandler));

router.patch('/enrollments/:enrollmentId', requirePermission('enrollments.manage'), asyncHandler(controller.updateEnrollmentHandler));
router.delete('/teacher-assignments/:assignmentId', requirePermission('assignments.teacher.manage'), asyncHandler(controller.removeAssignmentHandler));

// --- subjects --------------------------------------------------------------
router.get('/subjects', requirePermission('subjects.read'), asyncHandler(controller.listSubjectsHandler));
router.post('/subjects', requirePermission('subjects.manage'), asyncHandler(controller.createSubjectHandler));
router.patch('/subjects/:subjectId', requirePermission('subjects.manage'), asyncHandler(controller.updateSubjectHandler));

export default router;
