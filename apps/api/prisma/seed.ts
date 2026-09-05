/**
 * Seed: institute branding, the self-study policy, the permission catalogue,
 * and a full demo cohort covering all five roles.
 *
 * Every write is an upsert, so running this repeatedly is safe and will not
 * duplicate a single row.
 *
 * Set SEED_DEMO=false to load the baseline configuration without demo accounts,
 * which is what a real institute wants on its first production deploy.
 */
import { PrismaClient, Role, StaffType, Gender, ParentRelation } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PERMISSIONS, ROLE_MATRIX } from '../src/modules/auth/permissions.catalog';

const prisma = new PrismaClient();

const INSTITUTE_CODE = 'TSA';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Tsa@Demo2026';
const SEED_DEMO = process.env.SEED_DEMO !== 'false';
const ACADEMIC_YEAR = '2025-26';

/** Times of day are stored as minutes from midnight. */
const hm = (h: number, m = 0): number => h * 60 + m;

async function main(): Promise<void> {
  // ------------------------------------------------------------- institute --
  const institute = await prisma.institute.upsert({
    where: { code: INSTITUTE_CODE },
    update: {},
    create: {
      code: INSTITUTE_CODE,
      name: 'The Scholastic Academy',
      tagline: 'strive for success',
      logoUrl: '/logo.svg',
      primaryColor: '#5CB82B',
      secondaryColor: '#101418',
      accentColor: '#E8A317',
      timezone: 'Asia/Kolkata',
      locale: 'en-IN',
      currency: 'INR',
      academicYear: ACADEMIC_YEAR,
    },
  });
  console.log(`Institute ready: ${institute.name} (${institute.code})`);

  // -------------------------------------------------- self-study scheduling --
  const policy = await prisma.selfStudyPolicy.upsert({
    where: { instituteId_name: { instituteId: institute.id, name: 'Default policy' } },
    update: {},
    create: {
      instituteId: institute.id,
      name: 'Default policy',
      defaultDurationMin: 120,
      taskCount: 2,
      focusMinPerTask: 45,
      evaluationMinPerTask: 15,
      newSessionCutoffMin: hm(21, 30),
      blackoutEndMin: hm(0, 30),
      minGapAfterClassMin: 60,
      reminderLeadMin: 15,
    },
  });
  console.log('Self-study policy ready (cutoff 21:30, blackout until 00:30)');

  const rules = [
    {
      label: 'Afternoon lecture -> evening study',
      lectureStartMinFrom: hm(13, 0),
      lectureStartMinTo: hm(15, 59),
      selfStudyStartMin: hm(19, 0),
      dayOffset: 'SAME_DAY' as const,
      priority: 10,
    },
    {
      label: 'Late-afternoon lecture -> later evening study',
      lectureStartMinFrom: hm(16, 0),
      lectureStartMinTo: hm(17, 59),
      selfStudyStartMin: hm(19, 30),
      dayOffset: 'SAME_DAY' as const,
      priority: 20,
    },
    {
      label: 'Evening lecture -> next-day afternoon study',
      lectureStartMinFrom: hm(18, 0),
      lectureStartMinTo: hm(20, 59),
      selfStudyStartMin: hm(14, 0),
      dayOffset: 'NEXT_DAY' as const,
      priority: 30,
    },
    {
      label: 'Morning lecture -> same-day evening study',
      lectureStartMinFrom: hm(7, 0),
      lectureStartMinTo: hm(12, 59),
      selfStudyStartMin: hm(19, 0),
      dayOffset: 'SAME_DAY' as const,
      priority: 40,
    },
  ];

  for (const rule of rules) {
    const existing = await prisma.selfStudyRule.findFirst({
      where: { policyId: policy.id, label: rule.label },
    });
    if (existing) {
      await prisma.selfStudyRule.update({
        where: { id: existing.id },
        data: { ...rule, durationMin: 120, isActive: true },
      });
    } else {
      await prisma.selfStudyRule.create({
        data: { ...rule, policyId: policy.id, durationMin: 120 },
      });
    }
  }
  console.log(`Self-study rules ready: ${rules.length}`);

  // ------------------------------------------------------------- permissions --
  for (const definition of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: definition.key },
      update: {
        resource: definition.resource,
        action: definition.action,
        description: definition.description,
        isSensitive: definition.isSensitive,
      },
      create: definition,
    });
  }

  const permissionRows = await prisma.permission.findMany({ select: { id: true, key: true } });
  const permissionIdByKey = new Map(permissionRows.map((row) => [row.key, row.id]));

  let roleLinks = 0;
  for (const [role, keys] of Object.entries(ROLE_MATRIX)) {
    for (const key of keys) {
      const permissionId = permissionIdByKey.get(key);
      if (!permissionId) continue;

      const existing = await prisma.rolePermission.findUnique({
        where: { role_permissionId: { role: role as Role, permissionId } },
        select: { id: true },
      });

      if (!existing) {
        await prisma.rolePermission.create({ data: { role: role as Role, permissionId } });
        roleLinks += 1;
      }
    }
  }
  console.log(`Permissions ready: ${PERMISSIONS.length} keys, ${roleLinks} new role links`);

  // ------------------------------------------------------------------ badges --
  const badges = [
    { key: 'streak_7', name: 'Seven in a row', description: 'Completed self-study seven days running.', iconKey: 'flame', criteria: { type: 'STREAK', threshold: 7 } },
    { key: 'streak_30', name: 'Month of momentum', description: 'Thirty consecutive days of self-study.', iconKey: 'trophy', criteria: { type: 'STREAK', threshold: 30 } },
    { key: 'first_viva', name: 'First viva cleared', description: 'Finished your first AI viva.', iconKey: 'mic', criteria: { type: 'VIVA_COUNT', threshold: 1 } },
    { key: 'topic_master', name: 'Topic mastered', description: 'Reached Mastered on any topic.', iconKey: 'target', criteria: { type: 'MASTERY', level: 'MASTERED' } },
    { key: 'perfect_week', name: 'Perfect week', description: 'Full attendance and every homework submitted.', iconKey: 'calendar-check', criteria: { type: 'PERFECT_WEEK' } },
    { key: 'comeback', name: 'Comeback', description: 'Moved a weak topic up two mastery levels.', iconKey: 'trending-up', criteria: { type: 'MASTERY_JUMP', levels: 2 } },
  ];

  for (const badge of badges) {
    await prisma.badge.upsert({
      where: { key: badge.key },
      update: { name: badge.name, description: badge.description, iconKey: badge.iconKey },
      create: badge,
    });
  }
  console.log(`Badges ready: ${badges.length}`);

  if (!SEED_DEMO) {
    console.log('\nSEED_DEMO=false — skipping demo accounts.');
    return;
  }

  // ---------------------------------------------------------------- subjects --
  const subjectSpecs = [
    { name: 'Physics', code: 'PHY', colorHex: '#5CB82B', iconKey: 'atom' },
    { name: 'Chemistry', code: 'CHEM', colorHex: '#E8A317', iconKey: 'flask' },
    { name: 'Mathematics', code: 'MATH', colorHex: '#2F6FD0', iconKey: 'sigma' },
    { name: 'Biology', code: 'BIO', colorHex: '#3D8C1B', iconKey: 'leaf' },
    { name: 'English', code: 'ENG', colorHex: '#8B5CF6', iconKey: 'book-open' },
  ];

  const subjects = new Map<string, string>();
  for (const spec of subjectSpecs) {
    const record = await prisma.subject.upsert({
      where: { instituteId_code: { instituteId: institute.id, code: spec.code } },
      update: { name: spec.name, colorHex: spec.colorHex, iconKey: spec.iconKey },
      create: { ...spec, instituteId: institute.id },
      select: { id: true, code: true },
    });
    subjects.set(record.code, record.id);
  }
  console.log(`Subjects ready: ${subjects.size}`);

  // ------------------------------------------------------- classes & batches --
  const classSpecs = [
    { name: 'Class 10', code: 'X', gradeLevel: 10, description: 'CBSE Class 10 board preparation' },
    { name: 'Class 12 Science', code: 'XII-SCI', gradeLevel: 12, description: 'Class 12 PCM/PCB with JEE and NEET support' },
  ];

  const classes = new Map<string, string>();
  for (const spec of classSpecs) {
    const record = await prisma.classGroup.upsert({
      where: {
        instituteId_code_academicYear: {
          instituteId: institute.id,
          code: spec.code,
          academicYear: ACADEMIC_YEAR,
        },
      },
      update: { name: spec.name, description: spec.description },
      create: { ...spec, instituteId: institute.id, academicYear: ACADEMIC_YEAR },
      select: { id: true, code: true },
    });
    classes.set(record.code, record.id);
  }

  const batchSpecs = [
    { classCode: 'X', name: 'Class 10 — Morning', code: 'X-A', capacity: 40, room: 'Room 201' },
    { classCode: 'X', name: 'Class 10 — Evening', code: 'X-B', capacity: 35, room: 'Room 202' },
    { classCode: 'XII-SCI', name: 'Class 12 Science — Morning', code: 'XII-A', capacity: 30, room: 'Lab Block 1' },
  ];

  const batches = new Map<string, string>();
  for (const spec of batchSpecs) {
    const classGroupId = classes.get(spec.classCode);
    if (!classGroupId) continue;

    const record = await prisma.batch.upsert({
      where: { classGroupId_code: { classGroupId, code: spec.code } },
      update: { name: spec.name, capacity: spec.capacity, room: spec.room },
      create: {
        classGroupId,
        name: spec.name,
        code: spec.code,
        capacity: spec.capacity,
        room: spec.room,
      },
      select: { id: true, code: true },
    });
    batches.set(record.code, record.id);
  }
  console.log(`Classes ready: ${classes.size}, batches: ${batches.size}`);

  // ------------------------------------------------------------- demo users --
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  async function upsertUser(spec: {
    email: string;
    firstName: string;
    lastName: string;
    role: Role;
    phone?: string;
  }): Promise<string> {
    const user = await prisma.user.upsert({
      where: { email: spec.email },
      update: { firstName: spec.firstName, lastName: spec.lastName, role: spec.role },
      create: {
        instituteId: institute.id,
        email: spec.email,
        phone: spec.phone ?? null,
        passwordHash,
        role: spec.role,
        firstName: spec.firstName,
        lastName: spec.lastName,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        isDemoAccount: true,
      },
      select: { id: true },
    });
    return user.id;
  }

  // --- admin ---------------------------------------------------------------
  const adminUserId = await upsertUser({
    email: 'admin@tsa.edu.in',
    firstName: 'Meera',
    lastName: 'Deshpande',
    role: Role.ADMIN,
    phone: '+919820000001',
  });

  await prisma.staffProfile.upsert({
    where: { userId: adminUserId },
    update: {},
    create: {
      userId: adminUserId,
      staffType: StaffType.ADMIN,
      employeeCode: 'TSA-ADM-001',
      designation: 'Centre Administrator',
      department: 'Operations',
      // An administrator operates the system, so aggregate-only does not apply.
      accessScope: { aggregateOnly: false },
    },
  });

  // --- management ----------------------------------------------------------
  const managementUserId = await upsertUser({
    email: 'director@tsa.edu.in',
    firstName: 'Anil',
    lastName: 'Rao',
    role: Role.MANAGEMENT,
    phone: '+919820000002',
  });

  await prisma.staffProfile.upsert({
    where: { userId: managementUserId },
    update: {},
    create: {
      userId: managementUserId,
      staffType: StaffType.MANAGEMENT,
      employeeCode: 'TSA-MGT-001',
      designation: 'Director',
      department: 'Management',
      // The brief is explicit: management sees institute health, not a named
      // child's marks. Lifting this is an admin action and lands in the audit log.
      accessScope: { aggregateOnly: true },
    },
  });

  // --- teachers ------------------------------------------------------------
  const teacherSpecs = [
    {
      email: 'r.iyer@tsa.edu.in',
      firstName: 'Rohan',
      lastName: 'Iyer',
      employeeCode: 'TSA-TCH-001',
      qualification: 'M.Sc. Physics, B.Ed.',
      specialization: 'Mechanics and Electromagnetism',
      experienceYear: 11,
      subjectCode: 'PHY',
      batchCodes: ['X-A', 'XII-A'],
    },
    {
      email: 's.khan@tsa.edu.in',
      firstName: 'Sana',
      lastName: 'Khan',
      employeeCode: 'TSA-TCH-002',
      qualification: 'M.Sc. Mathematics',
      specialization: 'Calculus and Coordinate Geometry',
      experienceYear: 7,
      subjectCode: 'MATH',
      batchCodes: ['X-A', 'X-B', 'XII-A'],
    },
    {
      email: 'a.nair@tsa.edu.in',
      firstName: 'Anjali',
      lastName: 'Nair',
      employeeCode: 'TSA-TCH-003',
      qualification: 'M.Sc. Chemistry, Ph.D.',
      specialization: 'Organic Chemistry',
      experienceYear: 14,
      subjectCode: 'CHEM',
      batchCodes: ['X-B', 'XII-A'],
    },
  ];

  for (const spec of teacherSpecs) {
    const userId = await upsertUser({
      email: spec.email,
      firstName: spec.firstName,
      lastName: spec.lastName,
      role: Role.TEACHER,
    });

    const teacher = await prisma.teacherProfile.upsert({
      where: { userId },
      update: { qualification: spec.qualification, specialization: spec.specialization },
      create: {
        userId,
        employeeCode: spec.employeeCode,
        qualification: spec.qualification,
        specialization: spec.specialization,
        experienceYear: spec.experienceYear,
        isFullTime: true,
      },
      select: { id: true },
    });

    const subjectId = subjects.get(spec.subjectCode);
    if (!subjectId) continue;

    for (const batchCode of spec.batchCodes) {
      const batchId = batches.get(batchCode);
      if (!batchId) continue;

      await prisma.teacherAssignment.upsert({
        where: {
          teacherId_batchId_subjectId: { teacherId: teacher.id, batchId, subjectId },
        },
        update: {},
        create: { teacherId: teacher.id, batchId, subjectId, isPrimary: true },
      });
    }
  }
  console.log(`Teachers ready: ${teacherSpecs.length}`);

  // --- students ------------------------------------------------------------
  const studentSpecs = [
    { first: 'Aarav', last: 'Sharma', batch: 'X-A', roll: '01', gender: Gender.MALE },
    { first: 'Diya', last: 'Patel', batch: 'X-A', roll: '02', gender: Gender.FEMALE },
    { first: 'Kabir', last: 'Menon', batch: 'X-A', roll: '03', gender: Gender.MALE },
    { first: 'Ishita', last: 'Joshi', batch: 'X-A', roll: '04', gender: Gender.FEMALE },
    { first: 'Vivaan', last: 'Reddy', batch: 'X-B', roll: '01', gender: Gender.MALE },
    { first: 'Ananya', last: 'Bose', batch: 'X-B', roll: '02', gender: Gender.FEMALE },
    { first: 'Rehan', last: 'Qureshi', batch: 'XII-A', roll: '01', gender: Gender.MALE },
    { first: 'Sneha', last: 'Kulkarni', batch: 'XII-A', roll: '02', gender: Gender.FEMALE },
  ];

  const studentIdByName = new Map<string, string>();

  for (const [index, spec] of studentSpecs.entries()) {
    const email = `${spec.first.toLowerCase()}.${spec.last.toLowerCase()}@student.tsa.edu.in`;
    const userId = await upsertUser({
      email,
      firstName: spec.first,
      lastName: spec.last,
      role: Role.STUDENT,
    });

    const admissionNumber = `TSA/${ACADEMIC_YEAR.slice(0, 4)}/${String(index + 1).padStart(4, '0')}`;

    const student = await prisma.studentProfile.upsert({
      where: { userId },
      update: { rollNumber: spec.roll },
      create: {
        userId,
        admissionNumber,
        rollNumber: spec.roll,
        gender: spec.gender,
        city: 'Mumbai',
        state: 'Maharashtra',
        boardName: 'CBSE',
        admissionDate: new Date(`${ACADEMIC_YEAR.slice(0, 4)}-04-01`),
      },
      select: { id: true },
    });

    studentIdByName.set(`${spec.first} ${spec.last}`, student.id);

    const batchId = batches.get(spec.batch);
    if (!batchId) continue;

    const existingEnrollment = await prisma.enrollment.findUnique({
      where: { studentId_batchId: { studentId: student.id, batchId } },
      select: { id: true },
    });

    if (!existingEnrollment) {
      await prisma.enrollment.create({
        data: { studentId: student.id, batchId, rollNumber: spec.roll },
      });
    }
  }
  console.log(`Students ready: ${studentSpecs.length}`);

  // --- parents -------------------------------------------------------------
  const parentSpecs = [
    { email: 'parent.sharma@example.com', first: 'Rajesh', last: 'Sharma', child: 'Aarav Sharma', relation: ParentRelation.FATHER },
    { email: 'parent.patel@example.com', first: 'Nisha', last: 'Patel', child: 'Diya Patel', relation: ParentRelation.MOTHER },
    { email: 'parent.qureshi@example.com', first: 'Farah', last: 'Qureshi', child: 'Rehan Qureshi', relation: ParentRelation.MOTHER },
    { email: 'parent.kulkarni@example.com', first: 'Suresh', last: 'Kulkarni', child: 'Sneha Kulkarni', relation: ParentRelation.FATHER },
  ];

  for (const spec of parentSpecs) {
    const userId = await upsertUser({
      email: spec.email,
      firstName: spec.first,
      lastName: spec.last,
      role: Role.PARENT,
    });

    const parent = await prisma.parentProfile.upsert({
      where: { userId },
      update: {},
      create: { userId, city: 'Mumbai' },
      select: { id: true },
    });

    const studentId = studentIdByName.get(spec.child);
    if (!studentId) continue;

    await prisma.parentStudentLink.upsert({
      where: { parentId_studentId: { parentId: parent.id, studentId } },
      update: { relation: spec.relation, isPrimary: true },
      create: {
        parentId: parent.id,
        studentId,
        relation: spec.relation,
        isPrimary: true,
        canViewFees: true,
        canViewReport: true,
      },
    });
  }
  console.log(`Parents ready: ${parentSpecs.length}`);

  // --------------------------------------------------------------- vivas --
  // A handful of already-completed viva sessions so the "AI Viva" screen has
  // something to show the moment a demo account signs in, without needing a
  // live AI provider key or indexed course material during a walkthrough.
  const vivaSpecs = [
    {
      studentName: 'Aarav Sharma',
      subjectCode: 'PHY',
      durationMin: 15,
      daysAgo: 2,
      startDifficulty: 'MEDIUM' as const,
      endDifficulty: 'HARD' as const,
      overallScore: 8.5,
      maxScore: 10,
      conceptualScore: 8.5,
      communicationScore: 7.8,
      summary:
        'Confidently explained Newton\'s laws with correct real-world examples. Reasoning about friction and momentum was mostly solid, with one gap on the direction of the reaction force in the third law.',
      strengths: ['Clear definitions', 'Good real-world examples', 'Followed up on probes well'],
      weaknesses: ['Direction of reaction forces', 'Occasionally rushed the explanation of units'],
      questions: [
        {
          body: "Let's start simple — can you state Newton's first law of motion, and explain what 'inertia' means in your own words?",
          difficulty: 'MEDIUM' as const,
          expectedPoints: ['Object at rest/motion stays that way unless acted on by a net force', 'Inertia is resistance to change in motion'],
          transcript:
            "Newton's first law says an object at rest stays at rest, and an object in motion stays in motion at the same speed and direction, unless a net force acts on it. Inertia basically means how much an object resists changing its state of motion — like a heavier object has more inertia so it's harder to start or stop moving.",
          score: 9,
          maxScore: 10,
          verdict: 'correct',
          whatWentRight: 'Correctly stated the law and linked inertia to resistance to change in motion, with mass as the relevant factor.',
          whatWentWrong: null,
          whyItWentWrong: null,
          correctApproach: null,
          improvementTip: 'You could mention that inertia is specifically tied to mass to make the definition airtight.',
        },
        {
          body: 'Good. Now, a heavier box and a lighter box are pushed with the same force across a rough floor. Which one accelerates more, and why?',
          difficulty: 'MEDIUM' as const,
          isFollowUp: true,
          expectedPoints: ['F = ma, so lower mass means higher acceleration for the same force', 'Friction also plays a role but is secondary here'],
          transcript:
            'The lighter box will accelerate more because of F equals m a — if the force is the same and mass is smaller, acceleration has to be bigger. The friction would resist both but the lighter one still speeds up faster.',
          score: 9,
          maxScore: 10,
          verdict: 'correct',
          whatWentRight: 'Correct application of F = ma with clear reasoning about the inverse relationship between mass and acceleration.',
          whatWentWrong: null,
          whyItWentWrong: null,
          correctApproach: null,
          improvementTip: null,
        },
        {
          body: "Let's move to the third law. When you push against a wall, the wall pushes back on you. Explain why you don't move the wall, using Newton's third law.",
          difficulty: 'HARD' as const,
          expectedPoints: ['Action-reaction pair is equal and opposite', 'Wall is fixed to the ground/has far greater effective mass, so its acceleration is negligible'],
          transcript:
            'By the third law, when I push the wall, the wall pushes me back with an equal force in the same direction. Since the forces are equal, neither of us moves.',
          score: 5,
          maxScore: 10,
          verdict: 'partially_correct',
          whatWentRight: 'Correctly identified that the wall exerts an equal and opposite reaction force.',
          whatWentWrong: "Said the reaction force acts 'in the same direction' — it's actually opposite in direction, and the explanation didn't address why the wall itself doesn't visibly move (its effective mass is enormous, so its acceleration is negligible).",
          whyItWentWrong: 'Likely conflated "equal in magnitude" with "same in every respect," missing that direction is reversed in an action-reaction pair.',
          correctApproach: "State that the reaction is equal in magnitude but opposite in direction, and that the wall's connection to the ground gives it an effectively enormous mass, so F = ma predicts practically zero acceleration for it.",
          improvementTip: "Practice narrating action-reaction pairs by explicitly saying 'equal and opposite' every time — direction is the part students most often drop.",
        },
      ],
    },
    {
      studentName: 'Rehan Qureshi',
      subjectCode: 'MATH',
      durationMin: 15,
      daysAgo: 1,
      startDifficulty: 'MEDIUM' as const,
      endDifficulty: 'MEDIUM' as const,
      overallScore: 6.2,
      maxScore: 10,
      conceptualScore: 6.5,
      communicationScore: 6.0,
      summary:
        'Solid grasp of the quadratic formula and factoring, but hesitated when asked to justify why the discriminant determines the number of real roots. Would benefit from connecting the algebra back to the graph.',
      strengths: ['Comfortable with standard factoring', 'Recovered well after a hint'],
      weaknesses: ['Connecting discriminant sign to number of roots', 'Explaining reasoning out loud rather than just stating the formula'],
      questions: [
        {
          body: 'Solve the quadratic equation x squared minus 5x plus 6 equals 0, and briefly explain your method.',
          difficulty: 'MEDIUM' as const,
          expectedPoints: ['Factor as (x-2)(x-3) = 0', 'Roots are x = 2 and x = 3'],
          transcript:
            "I need two numbers that multiply to 6 and add to minus 5, so that's minus 2 and minus 3. So it factors to x minus 2 times x minus 3 equals 0, which gives x equals 2 or x equals 3.",
          score: 8,
          maxScore: 10,
          verdict: 'correct',
          whatWentRight: 'Correct factoring method and correct final roots.',
          whatWentWrong: null,
          whyItWentWrong: null,
          correctApproach: null,
          improvementTip: 'Stating the check step — substituting a root back in — would make the answer fully complete.',
        },
        {
          body: 'Now, without solving it fully, how can you tell how many real roots the equation 2x squared + 3x + 5 = 0 has?',
          difficulty: 'MEDIUM' as const,
          isFollowUp: true,
          expectedPoints: ['Use the discriminant b^2 - 4ac', 'Discriminant here is negative, so no real roots'],
          transcript: 'Um, I think you use the discriminant, b squared minus 4ac. Let me think... I would need to calculate that to be sure.',
          score: 3,
          maxScore: 10,
          verdict: 'partially_correct',
          whatWentRight: 'Correctly recalled that the discriminant b² - 4ac is the relevant tool.',
          whatWentWrong: 'Did not actually compute the discriminant or state what its sign implies about the number of real roots.',
          whyItWentWrong: 'Recognised the formula but had not connected it to the rule (positive → two real roots, zero → one, negative → none).',
          correctApproach: 'Compute b² - 4ac = 9 - 40 = -31. Since this is negative, the equation has no real roots.',
          improvementTip: 'Memorise the three-way rule for the discriminant sign alongside the formula itself, not just the formula on its own.',
        },
      ],
    },
  ];

  for (const spec of vivaSpecs) {
    const studentId = studentIdByName.get(spec.studentName);
    const subjectId = subjects.get(spec.subjectCode);
    if (!studentId || !subjectId) continue;

    const startedAt = new Date(Date.now() - spec.daysAgo * 24 * 60 * 60 * 1000);
    const endedAt = new Date(startedAt.getTime() + spec.durationMin * 60 * 1000);

    const existingSession = await prisma.vivaSession.findFirst({
      where: { studentId, subjectId, startedAt },
      select: { id: true },
    });
    if (existingSession) continue; // already seeded on a previous run

    const session = await prisma.vivaSession.create({
      data: {
        studentId,
        subjectId,
        durationMin: spec.durationMin,
        status: 'COMPLETED',
        startedAt,
        endedAt,
        overallScore: spec.overallScore,
        maxScore: spec.maxScore,
        conceptualScore: spec.conceptualScore,
        communicationScore: spec.communicationScore,
        summary: spec.summary,
        strengths: spec.strengths,
        weaknesses: spec.weaknesses,
        startDifficulty: spec.startDifficulty,
        endDifficulty: spec.endDifficulty,
        voiceEnabled: true,
        proctoringEnabled: false,
        createdAt: startedAt,
      },
      select: { id: true },
    });

    for (const [index, question] of spec.questions.entries()) {
      const askedAt = new Date(startedAt.getTime() + index * 3 * 60 * 1000);

      const questionRecord = await prisma.vivaQuestion.create({
        data: {
          vivaSessionId: session.id,
          orderIndex: index,
          body: question.body,
          expectedPoints: question.expectedPoints,
          difficulty: question.difficulty,
          isFollowUp: question.isFollowUp ?? false,
          askedAt,
          createdAt: askedAt,
        },
        select: { id: true },
      });

      const answer = await prisma.vivaAnswer.create({
        data: {
          vivaQuestionId: questionRecord.id,
          transcript: question.transcript,
          sttProvider: 'web-speech-api',
          sttConfidence: 0.91,
          durationSec: 35 + index * 10,
          answeredAt: new Date(askedAt.getTime() + 90 * 1000),
          createdAt: askedAt,
        },
        select: { id: true },
      });

      await prisma.aiEvaluation.create({
        data: {
          vivaAnswerId: answer.id,
          source: 'AI',
          score: question.score,
          maxScore: question.maxScore,
          isCorrect: question.verdict === 'correct',
          verdict: question.verdict,
          whatWentRight: question.whatWentRight,
          whatWentWrong: question.whatWentWrong,
          whyItWentWrong: question.whyItWentWrong,
          correctApproach: question.correctApproach,
          improvementTip: question.improvementTip,
        },
      });
    }
  }
  console.log(`Viva sessions ready: ${vivaSpecs.length}`);

  // --------------------------------------------------------------- summary --
  console.log('\n--------------------------------------------------------');
  console.log('  DEMO SIGN-IN — every account uses the same password');
  console.log('--------------------------------------------------------');
  console.log(`  Password:    ${DEMO_PASSWORD}`);
  console.log('');
  console.log('  ADMIN        admin@tsa.edu.in');
  console.log('  MANAGEMENT   director@tsa.edu.in        (aggregate-only)');
  console.log('  TEACHER      r.iyer@tsa.edu.in          (Physics)');
  console.log('  TEACHER      s.khan@tsa.edu.in          (Mathematics)');
  console.log('  TEACHER      a.nair@tsa.edu.in          (Chemistry)');
  console.log('  STUDENT      aarav.sharma@student.tsa.edu.in');
  console.log('  STUDENT      rehan.qureshi@student.tsa.edu.in');
  console.log('  PARENT       parent.sharma@example.com  (child: Aarav)');
  console.log('  PARENT       parent.qureshi@example.com (child: Rehan)');
  console.log('--------------------------------------------------------');
  console.log('  Change DEMO_PASSWORD before exposing this to anyone.');
  console.log('--------------------------------------------------------');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log('\nSeed complete.');
  })
  .catch(async (error) => {
    console.error('\nSeed failed:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
