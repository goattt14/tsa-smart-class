import { Card } from '../components/ui/Card';
import { ErrorState, Skeleton } from '../components/ui/States';
import { useDashboard } from '../hooks/useApi';
import { AdminDashboard } from './dashboards/AdminDashboard';
import { ManagementDashboard } from './dashboards/ManagementDashboard';
import { ParentDashboard } from './dashboards/ParentDashboard';
import { StudentDashboard } from './dashboards/StudentDashboard';
import { TeacherDashboard } from './dashboards/TeacherDashboard';
import type {
  AdminDashboardData, ManagementDashboardData, ParentDashboardData,
  StudentDashboardData, TeacherDashboardData,
} from '../types/api';

/**
 * One endpoint, five screens.
 *
 * The server decides which shape to return from the caller's role, so the
 * client never has to guess which dashboard to request — and a role added
 * later needs no change to the routing.
 */
export function DashboardHome() {
  const { data, isPending, error, refetch } = useDashboard();

  if (isPending) {
    return (
      <Card>
        <Skeleton rows={6} />
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <ErrorState error={error} onRetry={() => void refetch()} />
      </Card>
    );
  }

  switch (data.role) {
    case 'STUDENT':
      return <StudentDashboard data={data.data as StudentDashboardData} />;
    case 'TEACHER':
      return <TeacherDashboard data={data.data as TeacherDashboardData} />;
    case 'PARENT':
      return <ParentDashboard data={data.data as ParentDashboardData} />;
    case 'MANAGEMENT':
      return <ManagementDashboard data={data.data as ManagementDashboardData} />;
    case 'ADMIN':
      return <AdminDashboard data={data.data as AdminDashboardData} />;
    default:
      return (
        <Card>
          <ErrorState error={new Error('No dashboard is defined for this role.')} />
        </Card>
      );
  }
}
