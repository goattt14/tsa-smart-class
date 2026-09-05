import { Router } from 'express';
import academicsRoutes from '../modules/academics/academics.routes';
import aiRoutes from '../modules/ai/ai.routes';
import attendanceRoutes from '../modules/attendance/attendance.routes';
import authRoutes from '../modules/auth/auth.routes';
import dailyLogRoutes from '../modules/dailylogs/dailylogs.routes';
import dashboardRoutes from '../modules/dashboard/dashboard.routes';
import feesRoutes from '../modules/fees/fees.routes';
import homeworkRoutes from '../modules/homework/homework.routes';
import materialsRoutes from '../modules/materials/materials.routes';
import notificationsRoutes from '../modules/notifications/notifications.routes';
import performanceRoutes from '../modules/performance/performance.routes';
import practiceRoutes from '../modules/practice/practice.routes';
import proctoringRoutes from '../modules/proctoring/proctoring.routes';
import questionsRoutes from '../modules/questions/questions.routes';
import selfStudyRoutes from '../modules/selfstudy/selfstudy.routes';
import testsRoutes from '../modules/tests/tests.routes';
import timetableRoutes from '../modules/timetable/timetable.routes';
import usersRoutes from '../modules/users/users.routes';
import vivaRoutes from '../modules/viva/viva.routes';
import healthRoute from './health.route';

const v1 = Router();

v1.use('/health', healthRoute);

// --- Phase 1 ---------------------------------------------------------------
v1.use('/auth', authRoutes);
v1.use('/users', usersRoutes);
v1.use('/academics', academicsRoutes);

// --- Phase 2 ---------------------------------------------------------------
v1.use('/timetable', timetableRoutes);
v1.use('/attendance', attendanceRoutes);
v1.use('/materials', materialsRoutes);
v1.use('/daily-logs', dailyLogRoutes);
v1.use('/self-study', selfStudyRoutes);

// --- Phase 3 ---------------------------------------------------------------
v1.use('/questions', questionsRoutes);
v1.use('/tests', testsRoutes);
v1.use('/homework', homeworkRoutes);
v1.use('/performance', performanceRoutes);

// --- Phase 4 ---------------------------------------------------------------
v1.use('/ai', aiRoutes);
v1.use('/practice', practiceRoutes);

// --- Phase 5 ---------------------------------------------------------------
v1.use('/viva', vivaRoutes);
v1.use('/proctoring', proctoringRoutes);

// --- Phase 6 ---------------------------------------------------------------
v1.use('/dashboard', dashboardRoutes);
v1.use('/fees', feesRoutes);
v1.use('/notifications', notificationsRoutes);


export default v1;
