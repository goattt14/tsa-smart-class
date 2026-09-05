export type Role = 'STUDENT' | 'TEACHER' | 'PARENT' | 'ADMIN' | 'MANAGEMENT';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  status: string;
  mustChangePassword: boolean;
  instituteId: string;
  profileId: string | null;
  permissions: string[];
}

export interface LoginResponse {
  user: AuthUser;
  accessToken: string;
  expiresIn: number;
}

export interface SubjectRef {
  id?: string;
  name: string;
  colorHex?: string | null;
}

export interface ClassBlock {
  id: string;
  startTimeMin: number;
  endTimeMin: number;
  room: string | null;
  status: string;
  subject: SubjectRef;
  teacher?: { user: { firstName: string; lastName: string } };
}

export interface StudyBlock {
  id: string;
  plannedStartMin: number;
  plannedEndMin: number;
  status: string;
  completionPct: number | null;
  classSession?: { subject: SubjectRef } | null;
}

export interface StudentDashboardData {
  student: {
    id: string;
    name: string;
    admissionNumber: string;
    avatarUrl: string | null;
    batches: { id: string; name: string }[];
  };
  today: { date: string; nowMinutes: number; classes: ClassBlock[]; selfStudy: StudyBlock[] };
  pendingHomework: {
    id: string;
    title: string;
    kind: string;
    dueAt: string;
    maxMarks: number;
    subject: SubjectRef;
  }[];
  upcomingTests: {
    id: string;
    title: string;
    scheduledAt: string;
    durationMin: number;
    maxMarks: number;
    subject: SubjectRef;
  }[];
  recentFeedback: {
    id: string;
    score: number;
    maxScore: number;
    verdict: string;
    whatWentRight: string;
    improvementTip: string | null;
    createdAt: string;
  }[];
  attendance30Day: {
    attendancePct: number | null;
    present: number;
    absent: number;
    counted: number;
  };
  recommendations: {
    id: string;
    kind: string;
    title: string;
    reason: string;
    topic: { id: string; name: string } | null;
  }[];
  unreadNotifications: number;
}

export interface TeacherDashboardData {
  today: {
    date: string;
    sessions: (ClassBlock & {
      batch: { id: string; name: string };
      dailyLog: { id: string; compliance: string } | null;
      _count: { attendance: number };
    })[];
  };
  actionsNeeded: {
    dailyLogsOutstanding: number;
    submissionsToGrade: number;
    aiTasksAwaitingReview: number;
  };
  myCompliancePct: number;
  batches: { batchId: string; batchName: string; studentCount: number; subject: SubjectRef }[];
  unreadNotifications: number;
}

export interface ParentDashboardData {
  children: {
    student: {
      id: string;
      name: string;
      admissionNumber: string;
      avatarUrl: string | null;
      relation: string;
    };
    canViewFees: boolean;
    canViewReport: boolean;
    attendancePct: number | null;
    recentResults: {
      id: string;
      percentage: number | null;
      rank: number | null;
      test: { title: string; maxMarks: number; subject: { name: string } };
    }[];
    homeworkSubmitted: number;
    pendingInvoices: number;
  }[];
}

export interface AdminDashboardData {
  date: string;
  people: Partial<Record<Role, number>>;
  today: {
    classesScheduled: number;
    attendanceMarked: number;
    attendancePct: number | null;
  };
  dailyLogs7Day: { missing: number };
  fees: {
    totalBilled: string;
    totalCollected: string;
    totalOutstanding: string;
    totalOverdue: string;
    collectionRatePct: number;
  };
  aiToday: { calls: number; tokens: number };
}

export interface ManagementDashboardData {
  windowDays: number;
  enrolment: Partial<Record<Role, number>>;
  attendancePct: number | null;
  teacherCompliance: {
    averagePct: number;
    lowest: { name: string; compliancePct: number; missing: number }[];
  };
  academic: { averageTestPct: number | null; attemptsEvaluated: number };
  selfStudy: { sessionsPlanned: number; completionPct: number | null };
  fees: { totalCollected: string; totalOutstanding: string; collectionRatePct: number };
}

export interface DashboardEnvelope {
  role: Role;
  data:
    | StudentDashboardData
    | TeacherDashboardData
    | ParentDashboardData
    | AdminDashboardData
    | ManagementDashboardData;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
