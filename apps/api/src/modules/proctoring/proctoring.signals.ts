/**
 * Proctoring signal handling.
 *
 * This module deliberately does not decide whether anyone cheated. It cannot.
 * A face leaving the frame means the camera stopped seeing a face — nothing
 * more. The student may have looked at their notebook, a sibling may have
 * walked past, the laptop lid may have shifted, or the lighting may simply be
 * poor in a room in Mumbai at nine at night.
 *
 * So everything here produces observations and confidence, never verdicts. The
 * output is designed to be read by a teacher who then makes a judgement, and
 * every summary carries that framing with it rather than leaving the interface
 * to remember to add it.
 */

export type EventType =
  | 'FACE_NOT_DETECTED'
  | 'MULTIPLE_FACES'
  | 'ATTENTION_AWAY'
  | 'TAB_HIDDEN'
  | 'WINDOW_BLUR'
  | 'FULLSCREEN_EXIT'
  | 'MIC_MUTED'
  | 'CAMERA_STOPPED'
  | 'DEVICE_CHANGED'
  | 'PASTE_DETECTED'
  | 'NETWORK_LOST';

export type Severity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface RawEvent {
  type: EventType;
  occurredAt: number;
  durationMs?: number | undefined;
  detail?: Record<string, unknown> | undefined;
}

/**
 * How much weight an observation carries, and how it should be described.
 *
 * Note how many of these are marked as having an innocent explanation. That is
 * the point: most signals a browser can produce are ambiguous, and a system
 * that presents them as evidence of misconduct will produce false accusations
 * against exactly the students with the worst equipment and the noisiest homes.
 */
interface EventProfile {
  baseSeverity: Severity;
  /** Counts towards the attention summary rather than being noise. */
  meaningful: boolean;
  label: string;
  /** The most likely innocent explanation, always shown alongside. */
  benignExplanation: string;
}

export const EVENT_PROFILES: Record<EventType, EventProfile> = {
  FACE_NOT_DETECTED: {
    baseSeverity: 'LOW',
    meaningful: true,
    label: 'No face visible to the camera',
    benignExplanation: 'Poor lighting, the camera angle, or looking down at paper.',
  },
  MULTIPLE_FACES: {
    baseSeverity: 'MEDIUM',
    meaningful: true,
    label: 'More than one face in frame',
    benignExplanation: 'A family member passing behind them, which is normal at home.',
  },
  ATTENTION_AWAY: {
    baseSeverity: 'LOW',
    meaningful: true,
    label: 'Looking away from the screen',
    benignExplanation: 'Thinking, or writing working out on paper.',
  },
  TAB_HIDDEN: {
    baseSeverity: 'MEDIUM',
    meaningful: true,
    label: 'Switched away from the tab',
    benignExplanation: 'A notification, or the device backgrounding the page on its own.',
  },
  WINDOW_BLUR: {
    baseSeverity: 'LOW',
    meaningful: true,
    label: 'Window lost focus',
    benignExplanation: 'A click outside the window, or another app taking focus.',
  },
  FULLSCREEN_EXIT: {
    baseSeverity: 'LOW',
    meaningful: true,
    label: 'Left fullscreen',
    benignExplanation: 'Pressing Escape by habit, or the browser exiting on its own.',
  },
  MIC_MUTED: {
    baseSeverity: 'INFO',
    meaningful: false,
    label: 'Microphone muted',
    benignExplanation: 'Background noise being managed, or a hardware mute switch.',
  },
  CAMERA_STOPPED: {
    baseSeverity: 'MEDIUM',
    meaningful: true,
    label: 'Camera stopped sending',
    benignExplanation: 'A dropped USB connection, a privacy shutter, or the device sleeping.',
  },
  DEVICE_CHANGED: {
    baseSeverity: 'INFO',
    meaningful: false,
    label: 'Audio or video device changed',
    benignExplanation: 'Headphones connected or disconnected.',
  },
  PASTE_DETECTED: {
    baseSeverity: 'MEDIUM',
    meaningful: true,
    label: 'Text pasted into an answer',
    benignExplanation: 'Moving their own draft across from notes they typed earlier.',
  },
  NETWORK_LOST: {
    baseSeverity: 'INFO',
    meaningful: false,
    label: 'Network dropped',
    benignExplanation: 'An unstable connection, which says nothing about the student.',
  },
};

/**
 * Escalates severity for duration, but never past MEDIUM on its own.
 *
 * Nothing a browser observes justifies HIGH by itself. HIGH is reserved for a
 * human reviewer to set after looking, so the system never hands a teacher a
 * pre-formed conclusion.
 */
export function severityFor(type: EventType, durationMs: number | undefined): Severity {
  const profile = EVENT_PROFILES[type];
  if (!durationMs) return profile.baseSeverity;

  if (durationMs >= 60_000 && profile.baseSeverity !== 'INFO') return 'MEDIUM';
  if (durationMs >= 20_000 && profile.baseSeverity === 'LOW') return 'MEDIUM';

  return profile.baseSeverity;
}

/**
 * Collapses a burst of identical events into one.
 *
 * A face detector running at 5fps can emit two hundred FACE_NOT_DETECTED events
 * while a student reads a question on paper. Storing all of them would both
 * flood the table and make a two-second glance look like two hundred incidents
 * on a teacher's screen.
 */
export function coalesce(events: RawEvent[], gapMs = 3000): RawEvent[] {
  const sorted = [...events].sort((a, b) => a.occurredAt - b.occurredAt);
  const merged: RawEvent[] = [];

  for (const event of sorted) {
    const previous = merged[merged.length - 1];
    const previousEnd = previous
      ? previous.occurredAt + (previous.durationMs ?? 0)
      : Number.NEGATIVE_INFINITY;

    if (previous && previous.type === event.type && event.occurredAt - previousEnd <= gapMs) {
      const end = Math.max(previousEnd, event.occurredAt + (event.durationMs ?? 0));
      previous.durationMs = Math.max(0, end - previous.occurredAt);
      continue;
    }

    merged.push({ ...event, durationMs: event.durationMs ?? 0 });
  }

  return merged;
}

export interface ObservationLine {
  type: EventType;
  label: string;
  count: number;
  totalMs: number;
  severity: Severity;
  benignExplanation: string;
}

export interface SessionSummary {
  sessionDurationMs: number;
  /** Share of the session with no face visible, 0..100. */
  faceAbsentPct: number;
  /** Share of the session with the tab in the background, 0..100. */
  awayPct: number;
  observations: ObservationLine[];
  /**
   * Whether a human should look. Never a statement that anything happened.
   */
  reviewSuggested: boolean;
  /** Why review is suggested, in plain language. */
  reviewReason: string | null;
  /**
   * How much the environment interfered with observation. High means the
   * signals are unreliable and should carry less weight, not more.
   */
  dataQuality: 'GOOD' | 'PARTIAL' | 'POOR';
  /** Always attached, so no interface can present this as a finding. */
  disclaimer: string;
}

export const PROCTORING_DISCLAIMER =
  'These are automated observations from the browser, not findings. Every one of them has ordinary explanations. Nothing here shows that a student did anything wrong, and none of it should be treated as evidence without a person reviewing the session and speaking to the student.';

/**
 * Builds the reviewer-facing summary.
 *
 * The thresholds are set high on purpose. A summary that suggests review for
 * every session trains teachers to ignore it, and the cost of that is that the
 * rare session genuinely worth a conversation gets ignored too.
 */
export function summarise(
  events: RawEvent[],
  sessionDurationMs: number,
): SessionSummary {
  const merged = coalesce(events);

  const byType = new Map<EventType, { count: number; totalMs: number; maxSeverity: Severity }>();
  const order: Severity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH'];

  for (const event of merged) {
    const entry = byType.get(event.type) ?? { count: 0, totalMs: 0, maxSeverity: 'INFO' as Severity };
    const severity = severityFor(event.type, event.durationMs);

    entry.count += 1;
    entry.totalMs += event.durationMs ?? 0;
    if (order.indexOf(severity) > order.indexOf(entry.maxSeverity)) entry.maxSeverity = severity;

    byType.set(event.type, entry);
  }

  const observations: ObservationLine[] = [...byType.entries()]
    .map(([type, entry]) => ({
      type,
      label: EVENT_PROFILES[type].label,
      count: entry.count,
      totalMs: entry.totalMs,
      severity: entry.maxSeverity,
      benignExplanation: EVENT_PROFILES[type].benignExplanation,
    }))
    .sort((a, b) => order.indexOf(b.severity) - order.indexOf(a.severity) || b.totalMs - a.totalMs);

  const safeDuration = Math.max(1, sessionDurationMs);
  const faceAbsentMs = byType.get('FACE_NOT_DETECTED')?.totalMs ?? 0;
  const cameraOffMs = byType.get('CAMERA_STOPPED')?.totalMs ?? 0;
  const awayMs = (byType.get('TAB_HIDDEN')?.totalMs ?? 0) + (byType.get('WINDOW_BLUR')?.totalMs ?? 0);

  const faceAbsentPct = Math.round(((faceAbsentMs + cameraOffMs) / safeDuration) * 1000) / 10;
  const awayPct = Math.round((awayMs / safeDuration) * 1000) / 10;

  // If the camera was down for most of the session, the other signals are
  // measuring almost nothing and should be discounted rather than stacked up.
  const dataQuality: SessionSummary['dataQuality'] =
    faceAbsentPct > 60 ? 'POOR' : faceAbsentPct > 25 ? 'PARTIAL' : 'GOOD';

  const reasons: string[] = [];

  const multipleFaces = byType.get('MULTIPLE_FACES');
  if (multipleFaces && multipleFaces.count >= 3 && multipleFaces.totalMs >= 30_000) {
    reasons.push('another face was in frame repeatedly and for some time');
  }

  if (awayPct >= 25) {
    reasons.push(`the tab was in the background for about ${awayPct}% of the session`);
  }

  const pastes = byType.get('PASTE_DETECTED');
  if (pastes && pastes.count >= 2) {
    reasons.push(`text was pasted ${pastes.count} times`);
  }

  // Poor data quality means fewer conclusions are available, so the bar for
  // suggesting review goes up rather than down.
  const reviewSuggested =
    dataQuality === 'POOR' ? reasons.length >= 2 : reasons.length >= 1;

  return {
    sessionDurationMs,
    faceAbsentPct,
    awayPct,
    observations,
    reviewSuggested,
    reviewReason: reviewSuggested
      ? `Worth a look because ${reasons.join(', and ')}. This is not an accusation.`
      : null,
    dataQuality,
    disclaimer: PROCTORING_DISCLAIMER,
  };
}

/**
 * What the student is told, live, while it is happening.
 *
 * Covert monitoring is not acceptable in a product used by children. If the
 * system noticed something, the student should see the same thing the teacher
 * will, at the time, in language that does not accuse them.
 */
export function studentNotice(type: EventType): string {
  switch (type) {
    case 'FACE_NOT_DETECTED':
      return 'Your camera cannot see you at the moment. Check the lighting and the angle.';
    case 'MULTIPLE_FACES':
      return 'The camera can see more than one person. Try to sit somewhere quieter if you can.';
    case 'CAMERA_STOPPED':
      return 'The camera has stopped. Your session is still running.';
    case 'TAB_HIDDEN':
    case 'WINDOW_BLUR':
      return 'You switched away from this page. Time is still counting.';
    case 'FULLSCREEN_EXIT':
      return 'You left fullscreen.';
    case 'NETWORK_LOST':
      return 'Your connection dropped. Your answers are saved on this device and will sync.';
    case 'PASTE_DETECTED':
      return 'Pasted text is recorded alongside your answer.';
    default:
      return 'Your session settings changed.';
  }
}

export interface ConsentState {
  cameraGranted: boolean;
  microphoneGranted: boolean;
  consentVersion: string | null;
  consentGivenAt: number | null;
}

export const CONSENT_VERSION = '2026-03-v1';

/**
 * Whether a monitored session may begin.
 *
 * Consent is explicit, versioned and re-collected when the terms change. A
 * student who declines is not blocked from studying — proctoring is switched
 * off and the session continues, marked as unmonitored, because refusing to be
 * filmed at home is a reasonable thing for a child to do.
 */
export function canStartMonitored(
  state: ConsentState,
  requiresCamera: boolean,
  requiresMicrophone: boolean,
): { allowed: boolean; reason: string | null; proceedUnmonitored: boolean } {
  if (state.consentVersion !== CONSENT_VERSION || !state.consentGivenAt) {
    return {
      allowed: false,
      reason: 'Consent has not been given for the current terms.',
      proceedUnmonitored: false,
    };
  }

  if (requiresCamera && !state.cameraGranted) {
    return {
      allowed: false,
      reason: 'Camera access was declined. The session can still run without monitoring.',
      proceedUnmonitored: true,
    };
  }

  if (requiresMicrophone && !state.microphoneGranted) {
    return {
      allowed: false,
      reason: 'Microphone access was declined. The viva can still run with typed answers.',
      proceedUnmonitored: true,
    };
  }

  return { allowed: true, reason: null, proceedUnmonitored: false };
}
