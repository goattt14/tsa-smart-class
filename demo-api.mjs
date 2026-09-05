import express from 'express';
import cors from 'cors';

const app = express();
const PORT = Number(process.env.PORT || 4000);
const frontendOrigins = [
  'https://tsa-smart-class-demo.loca.lt',
  'http://localhost:4173',
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:5173',
];

app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(express.json());

const buildUser = (email = 'demo@tsa.edu.in') => ({
  id: 'demo-student-1',
  email,
  role: 'STUDENT',
  firstName: 'Aarav',
  lastName: 'Sharma',
  avatarUrl: null,
  status: 'ACTIVE',
  mustChangePassword: false,
  instituteId: 'inst-demo',
  profileId: 'profile-demo',
  permissions: [
    'dashboard:view',
    'self-study:view',
    'attendance:view',
    'materials:view',
    'tests:view',
    'fees:view',
    'notifications:view',
  ],
});

const dashboardData = {
  role: 'STUDENT',
  data: {
    student: {
      id: 'demo-student-1',
      name: 'Aarav Sharma',
      admissionNumber: 'TSA-2041',
      avatarUrl: null,
      batches: [{ id: 'batch-12', name: 'Physics XI-A' }],
    },
    today: {
      date: new Date().toISOString().slice(0, 10),
      nowMinutes: 610,
      classes: [
        {
          id: 'class-1',
          startTimeMin: 510,
          endTimeMin: 570,
          room: 'A-12',
          status: 'SCHEDULED',
          subject: { name: 'Physics', colorHex: '#5CB82B' },
          teacher: { user: { firstName: 'Asha', lastName: 'Patel' } },
        },
        {
          id: 'class-2',
          startTimeMin: 585,
          endTimeMin: 660,
          room: 'Lab-2',
          status: 'SCHEDULED',
          subject: { name: 'Chemistry', colorHex: '#E8A317' },
          teacher: { user: { firstName: 'Rohan', lastName: 'Malik' } },
        },
      ],
      selfStudy: [
        {
          id: 'study-1',
          plannedStartMin: 570,
          plannedEndMin: 610,
          status: 'ACTIVE',
          completionPct: 70,
          classSession: { subject: { name: 'Physics', colorHex: '#5CB82B' } },
        },
      ],
    },
    pendingHomework: [
      {
        id: 'hw-1',
        title: 'Wave optics worksheet',
        kind: 'ASSIGNMENT',
        dueAt: new Date(Date.now() + 86400000).toISOString(),
        maxMarks: 20,
        subject: { name: 'Physics', colorHex: '#5CB82B' },
      },
      {
        id: 'hw-2',
        title: 'Acid-base lab reflection',
        kind: 'LAB_REPORT',
        dueAt: new Date(Date.now() + 3 * 86400000).toISOString(),
        maxMarks: 15,
        subject: { name: 'Chemistry', colorHex: '#E8A317' },
      },
    ],
    upcomingTests: [
      {
        id: 'test-1',
        title: 'Unit test — Electrostatics',
        scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(),
        durationMin: 45,
        maxMarks: 40,
        subject: { name: 'Physics', colorHex: '#5CB82B' },
      },
    ],
    recentFeedback: [
      {
        id: 'fb-1',
        score: 18,
        maxScore: 20,
        verdict: 'correct',
        whatWentRight: 'Your derivation was concise and your final units were exact.',
        improvementTip: 'Try using a quick sanity check before submitting.',
        createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      },
    ],
    attendance30Day: {
      attendancePct: 92,
      present: 23,
      absent: 2,
      counted: 25,
    },
    recommendations: [
      {
        id: 'rec-1',
        kind: 'TOPIC',
        title: 'Revisit current electricity basics',
        reason: 'You answered the MCQ set correctly but slowed down on the final derivation step.',
        topic: { id: 'topic-1', name: 'Current electricity' },
      },
    ],
    unreadNotifications: 3,
  },
};

const notificationData = {
  notifications: [
    {
      id: 'note-1',
      category: 'HOMEWORK',
      title: 'Homework due soon',
      body: 'Your Physics worksheet is due tomorrow at 6:00 PM.',
      actionUrl: '/today',
      readAt: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'note-2',
      category: 'TEST',
      title: 'Unit test scheduled',
      body: 'The electrostatics test is scheduled for Friday after lunch.',
      actionUrl: '/tests',
      readAt: null,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
    },
  ],
  unreadCount: 2,
  digestHeadline: 'Your class plan is looking strong this week.',
};

const testList = {
  tests: [
    {
      id: 'test-1',
      title: 'Unit test — Electrostatics',
      type: 'QUIZ',
      scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(),
      durationMin: 45,
      maxMarks: 40,
      resultsPublished: false,
      subject: { name: 'Physics', colorHex: '#5CB82B' },
      batch: { name: 'Physics XI-A' },
      _count: { questions: 12, attempts: 28 },
    },
  ],
};

const feeLedger = {
  student: { name: 'Aarav Sharma', admissionNumber: 'TSA-2041' },
  summary: {
    totalBilled: '₹28,500',
    totalPaid: '₹25,600',
    totalOutstanding: '₹2,900',
    overdueCount: 1,
    nextDue: { dueDate: '2026-08-31', amount: '₹1,450' },
    isClear: false,
  },
  lines: [],
};

const selfStudyData = {
  date: new Date().toISOString().slice(0, 10),
  nowMinutes: 610,
  windowOpen: true,
  windowMessage: 'Self-study window is open for this evening.',
  cutoffMin: 660,
  blackoutEndMin: 720,
  taskShape: { taskCount: 2, focusMinPerTask: 30, evaluationMinPerTask: 10 },
  sessions: [
    {
      id: 'study-1',
      plannedStartMin: 570,
      plannedEndMin: 610,
      durationMin: 40,
      status: 'ACTIVE',
      activeMinutes: 30,
      completionPct: 70,
      rule: { label: 'Daily practice' },
      classSession: { subject: { name: 'Physics', colorHex: '#5CB82B' } },
    },
  ],
};

app.options('*', (req, res) => res.sendStatus(204));

app.get('/api/v1/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok', service: 'tsa-demo-api', time: new Date().toISOString() } });
});

app.get('/api/v1/health/db', (req, res) => {
  res.json({ success: true, data: { status: 'ok', ready: true, source: 'demo-mock' } });
});

app.post('/api/v1/auth/login', (req, res) => {
  const email = String(req.body?.email || 'demo@tsa.edu.in');
  const password = String(req.body?.password || '');
  if (!email.includes('@') || !password) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Email and password are required.' } });
  }
  return res.json({
    success: true,
    data: {
      accessToken: 'demo-access-token',
      expiresIn: 3600,
      user: buildUser(email),
    },
  });
});

app.post('/api/v1/auth/refresh', (req, res) => {
  res.json({ success: true, data: { accessToken: 'demo-access-token', expiresIn: 3600, user: buildUser() } });
});

app.post('/api/v1/auth/logout', (req, res) => {
  res.json({ success: true, data: { message: 'Logged out' } });
});

app.post('/api/v1/auth/forgot-password', (req, res) => {
  res.json({ success: true, data: { message: 'Password reset link prepared in demo mode.', devToken: 'demo-reset-token' } });
});

app.post('/api/v1/auth/reset-password', (req, res) => {
  res.json({ success: true, data: { message: 'Password updated.' } });
});

app.get('/api/v1/dashboard', (req, res) => {
  res.json({ success: true, data: dashboardData });
});

app.get('/api/v1/notifications', (req, res) => {
  res.json({ success: true, data: notificationData });
});

app.post('/api/v1/notifications/read-all', (req, res) => {
  res.json({ success: true, data: { marked: 2, updated: 2, counts: { unread: 0 } } });
});

app.get('/api/v1/self-study/today', (req, res) => {
  res.json({ success: true, data: selfStudyData });
});

app.get('/api/v1/tests', (req, res) => {
  res.json({ success: true, data: testList });
});

app.get('/api/v1/materials', (req, res) => {
  res.json({ success: true, data: { items: [] } });
});

app.get('/api/v1/fees/ledger', (req, res) => {
  res.json({ success: true, data: feeLedger });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: { code: 'ROUTE_NOT_FOUND', message: 'Demo API route not found.' } });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Demo API listening on http://0.0.0.0:${PORT}`);
});
