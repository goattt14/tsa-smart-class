import { AttendanceStatus } from '@prisma/client';
import { z } from 'zod';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form YYYY-MM-DD');

export const markAttendanceSchema = z.object({
  entries: z
    .array(
      z.object({
        studentId: z.string().uuid(),
        status: z.nativeEnum(AttendanceStatus),
        minutesLate: z.coerce.number().int().min(0).max(300).optional(),
        remarks: z.string().trim().max(300).optional(),
      }),
    )
    .min(1)
    .max(300),
  /** Marks everyone not listed as present, which is how a teacher actually works. */
  defaultRemainingToPresent: z.boolean().default(false),
});

export const correctAttendanceSchema = z.object({
  status: z.nativeEnum(AttendanceStatus),
  minutesLate: z.coerce.number().int().min(0).max(300).nullable().optional(),
  remarks: z.string().trim().max(300).optional(),
  reason: z.string().trim().min(3).max(300),
});

export const attendanceReportSchema = z.object({
  from: dateString,
  to: dateString,
  batchId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  studentId: z.string().uuid().optional(),
});
