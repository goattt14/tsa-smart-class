import type { Role } from '@prisma/client';

/** Everything the auth layer proves about the caller of a request. */
export interface AuthContext {
  userId: string;
  instituteId: string;
  role: Role;
  email: string;
  /** Refresh-token family, so a session can be revoked without touching others. */
  sessionId: string;
  /** Resolved permission keys: role grants, plus user overrides. */
  permissions: Set<string>;
  /** Profile row id for the caller's role (student/teacher/parent/staff), if any. */
  profileId: string | null;
  /**
   * MANAGEMENT accounts default to aggregate-only access. When true, endpoints
   * that expose an identifiable individual student must refuse.
   */
  aggregateOnly: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      auth?: AuthContext;
    }
  }
}

export {};
