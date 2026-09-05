/**
 * Timetable conflict detection.
 *
 * Kept as pure functions with no database access so the rules can be tested
 * exhaustively and read by someone who does not know Prisma. A clash is the one
 * timetable bug that silently corrupts everything downstream — attendance,
 * daily logs, self-study scheduling all key off the session — so it is caught
 * at write time rather than discovered by a teacher standing in two rooms.
 */
import { formatMinutes, overlaps } from '../../lib/time';

export interface SlotShape {
  id?: string;
  batchId: string;
  subjectId: string;
  teacherId: string;
  weekday: string;
  startTimeMin: number;
  endTimeMin: number;
  room: string | null;
  /** YYYY-MM-DD */
  effectiveFrom: string;
  /** YYYY-MM-DD, or null for open-ended */
  effectiveTo: string | null;
  isActive: boolean;
}

export type ConflictKind = 'TEACHER' | 'BATCH' | 'ROOM';

export interface Conflict {
  kind: ConflictKind;
  existingSlotId: string;
  message: string;
}

/** Two date ranges overlap when neither ends before the other begins. */
export function rangesOverlap(
  aFrom: string,
  aTo: string | null,
  bFrom: string,
  bTo: string | null,
): boolean {
  const aEndsBeforeB = aTo !== null && aTo < bFrom;
  const bEndsBeforeA = bTo !== null && bTo < aFrom;
  return !aEndsBeforeB && !bEndsBeforeA;
}

export function validateSlotTimes(startTimeMin: number, endTimeMin: number): string | null {
  if (startTimeMin < 0 || startTimeMin >= 1440) return 'Start time must fall within the day.';
  if (endTimeMin <= startTimeMin) return 'The lecture must end after it starts.';
  if (endTimeMin > 1440) return 'A lecture cannot run past midnight.';
  if (endTimeMin - startTimeMin < 15) return 'A lecture must be at least 15 minutes long.';
  if (endTimeMin - startTimeMin > 300) return 'A single lecture longer than five hours is likely a typo.';
  return null;
}

/**
 * Returns every clash between a candidate slot and the existing timetable.
 *
 * All three checks are reported rather than the first one, because an admin
 * fixing a clash wants to see the whole picture instead of rediscovering a
 * second problem after fixing the first.
 */
export function findConflicts(candidate: SlotShape, existing: SlotShape[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const when = `${candidate.weekday} ${formatMinutes(candidate.startTimeMin)}-${formatMinutes(candidate.endTimeMin)}`;

  for (const slot of existing) {
    if (!slot.isActive) continue;
    if (candidate.id && slot.id === candidate.id) continue;
    if (slot.weekday !== candidate.weekday) continue;

    if (!overlaps(candidate.startTimeMin, candidate.endTimeMin, slot.startTimeMin, slot.endTimeMin)) {
      continue;
    }

    if (
      !rangesOverlap(
        candidate.effectiveFrom,
        candidate.effectiveTo,
        slot.effectiveFrom,
        slot.effectiveTo,
      )
    ) {
      continue;
    }

    if (slot.teacherId === candidate.teacherId) {
      conflicts.push({
        kind: 'TEACHER',
        existingSlotId: slot.id ?? '',
        message: `That teacher already has a lecture at ${when}.`,
      });
    }

    if (slot.batchId === candidate.batchId) {
      conflicts.push({
        kind: 'BATCH',
        existingSlotId: slot.id ?? '',
        message: `That batch already has a lecture at ${when}.`,
      });
    }

    if (candidate.room && slot.room && slot.room === candidate.room) {
      conflicts.push({
        kind: 'ROOM',
        existingSlotId: slot.id ?? '',
        message: `${candidate.room} is already booked at ${when}.`,
      });
    }
  }

  return conflicts;
}

/** Total scheduled minutes per weekday, for the workload view. */
export function weeklyLoadMinutes(slots: SlotShape[]): Record<string, number> {
  const load: Record<string, number> = {};
  for (const slot of slots) {
    if (!slot.isActive) continue;
    load[slot.weekday] = (load[slot.weekday] ?? 0) + (slot.endTimeMin - slot.startTimeMin);
  }
  return load;
}
