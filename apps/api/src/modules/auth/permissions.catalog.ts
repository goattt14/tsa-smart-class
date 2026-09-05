import { Role } from '@prisma/client';

export interface PermissionDefinition {
  key: string;
  resource: string;
  action: string;
  description: string;
  /**
   * Sensitive permissions expose an identifiable individual student: their
   * marks, attendance record, evaluations, proctoring observations or fees.
   * MANAGEMENT does not hold these by default.
   */
  isSensitive: boolean;
}

function p(
  key: string,
  description: string,
  isSensitive = false,
): PermissionDefinition {
  const [resource = key, action = 'read'] = key.split('.');
  return { key, resource, action, description, isSensitive };
}

/** The complete permission vocabulary. Every guard references a key from here. */
export const PERMISSIONS: PermissionDefinition[] = [
  // --- identity and access -------------------------------------------------
  p('users.read', 'View user accounts'),
  p('users.create', 'Create user accounts'),
  p('users.update', 'Edit user accounts'),
  p('users.disable', 'Suspend or disable user accounts'),
  p('users.impersonate', 'Sign in as another user for support', true),
  p('permissions.read', 'View the permission matrix'),
  p('permissions.assign', 'Grant or revoke permissions for a user'),

  // --- academic structure --------------------------------------------------
  p('classes.read', 'View classes'),
  p('classes.manage', 'Create and edit classes'),
  p('batches.read', 'View batches'),
  p('batches.manage', 'Create and edit batches'),
  p('subjects.read', 'View subjects'),
  p('subjects.manage', 'Create and edit subjects'),
  p('enrollments.read', 'View which students sit in which batch'),
  p('enrollments.manage', 'Enrol and transfer students'),
  p('assignments.teacher.read', 'View teacher-to-batch assignments'),
  p('assignments.teacher.manage', 'Assign teachers to batches and subjects'),

  // --- timetable and attendance -------------------------------------------
  p('timetable.read', 'View the timetable'),
  p('timetable.manage', 'Edit the timetable'),
  p('attendance.read', 'View attendance records', true),
  p('attendance.mark', 'Mark attendance'),
  p('attendance.update', 'Correct attendance already marked'),

  // --- teaching ------------------------------------------------------------
  p('materials.read', 'View study material'),
  p('materials.upload', 'Upload study material'),
  p('materials.delete', 'Delete study material'),
  p('dailylog.read', 'View teacher daily logs'),
  p('dailylog.write', 'Submit a teacher daily log'),
  p('dailylog.compliance', 'View daily-log compliance across teachers'),

  // --- work, tests, evaluation --------------------------------------------
  p('homework.read', 'View homework and assignments'),
  p('homework.manage', 'Create and edit homework'),
  p('homework.grade', 'Grade submissions', true),
  p('tests.read', 'View tests'),
  p('tests.manage', 'Create and publish tests'),
  p('questions.read', 'View the question bank'),
  p('questions.manage', 'Edit the question bank'),
  p('results.read.own', 'View your own results'),
  p('results.read.any', 'View any student results', true),
  p('results.publish', 'Publish results'),

  // --- AI, self-study, viva ------------------------------------------------
  p('selfstudy.policy.read', 'View self-study timing rules'),
  p('selfstudy.policy.manage', 'Edit self-study timing rules'),
  p('selfstudy.session.own', 'Run your own self-study sessions'),
  p('ai.tasks.generate', 'Generate AI study tasks from lecture material'),
  p('ai.tasks.review', 'Review and approve AI-generated tasks'),
  p('ai.evaluation.read', 'View AI evaluations', true),
  p('ai.evaluation.override', 'Override an AI evaluation', true),
  p('viva.conduct', 'Take part in a viva as the student'),
  p('viva.review', 'Review viva transcripts', true),
  p('proctoring.review', 'Review proctoring observations', true),

  // --- analytics -----------------------------------------------------------
  p('performance.read.own', 'View your own performance'),
  p('performance.read.child', 'View a linked child performance', true),
  p('performance.read.any', 'View any student performance', true),
  p('analytics.aggregate', 'View institute-level aggregate analytics'),
  p('reports.export', 'Export reports', true),

  // --- operations ----------------------------------------------------------
  p('fees.read.own', 'View your own fee record'),
  p('fees.read.any', 'View any fee record', true),
  p('fees.manage', 'Edit fee structures and invoices'),
  p('payments.record', 'Record a payment'),
  p('notifications.send', 'Send notifications and announcements'),
  p('settings.read', 'View institute settings'),
  p('settings.manage', 'Edit institute settings'),
  p('audit.read', 'Read the audit log'),
];

/**
 * The default matrix.
 *
 * MANAGEMENT deliberately holds analytics.aggregate and no `.any` permission:
 * the brief is explicit that management sees the health of the institute, not
 * a named child's marks. Where an individual view is genuinely needed, an admin
 * issues a scoped, expiring UserPermission GRANT, which is auditable.
 */
export const ROLE_MATRIX: Record<Role, string[]> = {
  [Role.STUDENT]: [
    'classes.read',
    'subjects.read',
    'timetable.read',
    'materials.read',
    'homework.read',
    'tests.read',
    'results.read.own',
    'selfstudy.session.own',
    'selfstudy.policy.read',
    'viva.conduct',
    'performance.read.own',
    'fees.read.own',
  ],

  [Role.TEACHER]: [
    'users.read',
    'classes.read',
    'batches.read',
    'subjects.read',
    'enrollments.read',
    'assignments.teacher.read',
    'timetable.read',
    'attendance.read',
    'attendance.mark',
    'attendance.update',
    'materials.read',
    'materials.upload',
    'materials.delete',
    'dailylog.read',
    'dailylog.write',
    'homework.read',
    'homework.manage',
    'homework.grade',
    'tests.read',
    'tests.manage',
    'questions.read',
    'questions.manage',
    'results.read.any',
    'results.publish',
    'selfstudy.policy.read',
    'ai.tasks.generate',
    'ai.tasks.review',
    'ai.evaluation.read',
    'ai.evaluation.override',
    'viva.review',
    'proctoring.review',
    'performance.read.any',
    'analytics.aggregate',
    'notifications.send',
  ],

  [Role.PARENT]: [
    'classes.read',
    'subjects.read',
    'timetable.read',
    'performance.read.child',
    'fees.read.own',
  ],

  [Role.ADMIN]: PERMISSIONS.map((perm) => perm.key),

  [Role.MANAGEMENT]: [
    'users.read',
    'classes.read',
    'batches.read',
    'subjects.read',
    'enrollments.read',
    'assignments.teacher.read',
    'timetable.read',
    'dailylog.compliance',
    'analytics.aggregate',
    'settings.read',
    'fees.manage',
    'audit.read',
  ],
};

export const SENSITIVE_KEYS = new Set(
  PERMISSIONS.filter((perm) => perm.isSensitive).map((perm) => perm.key),
);
