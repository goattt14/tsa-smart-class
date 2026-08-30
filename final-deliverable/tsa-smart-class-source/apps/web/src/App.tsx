import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { RequireAuth, RequirePermission } from './auth/RequireAuth';
import { DashboardHome } from './pages/DashboardHome';
import { LoginPage } from './pages/LoginPage';
import { NotFound } from './pages/NotFound';
import { AttendancePage } from './pages/work/AttendancePage';
import { FeesPage } from './pages/work/FeesPage';
import { MaterialsPage } from './pages/work/MaterialsPage';
import { NotificationsPage } from './pages/work/NotificationsPage';
import { TestAttemptPage } from './pages/work/TestAttemptPage';
import { TestsPage } from './pages/work/TestsPage';
import { TodayPage } from './pages/work/TodayPage';
import { VivaPage } from './pages/work/VivaPage';
import SystemStatus from './pages/SystemStatus';

export default function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<LoginPage />} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<DashboardHome />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="today" element={<RequirePermission permission="selfstudy.session.own"><TodayPage /></RequirePermission>} />
        <Route path="attendance" element={<RequirePermission permission="attendance.mark"><AttendancePage /></RequirePermission>} />
        <Route path="tests" element={<RequirePermission permission="tests.read"><TestsPage /></RequirePermission>} />
        <Route path="tests/:testId/attempt/:attemptId" element={<RequirePermission permission="tests.read"><TestAttemptPage /></RequirePermission>} />
        <Route path="materials" element={<RequirePermission permission="materials.read"><MaterialsPage /></RequirePermission>} />
        <Route path="viva" element={<RequirePermission permission="viva.conduct"><VivaPage /></RequirePermission>} />
        <Route path="fees" element={<FeesPage />} />
        <Route path="system" element={<SystemStatus />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
