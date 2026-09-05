/**
 * Notification dispatch rules.
 *
 * The whole point of this module is restraint. A study platform that can send a
 * push notification for every event will send forty a day, the student will
 * turn notifications off entirely, and then the one that mattered — the test
 * tomorrow morning — will not arrive either.
 *
 * So the rules here suppress aggressively, respect quiet hours, and treat the
 * student's evening as something to be protected rather than filled.
 *
 * Pure functions with no imports.
 */

export type Category =
  | 'CLASS_REMINDER'
  | 'SELF_STUDY_REMINDER'
  | 'VIVA_REMINDER'
  | 'HOMEWORK'
  | 'TEST'
  | 'RESULT'
  | 'ATTENDANCE'
  | 'FEES'
  | 'ANNOUNCEMENT'
  | 'SYSTEM'
  | 'PROCTORING';

export type Channel = 'IN_APP' | 'PUSH' | 'EMAIL' | 'SMS';

export interface Preferences {
  inAppEnabled: boolean;
  pushEnabled: boolean;
  emailEnabled: boolean;
  smsEnabled: boolean;
  classReminders: boolean;
  studyReminders: boolean;
  resultAlerts: boolean;
  feeAlerts: boolean;
  /** Minutes from midnight. Null means no quiet hours. */
  quietHoursStartMin: number | null;
  quietHoursEndMin: number | null;
}

export const DEFAULT_PREFERENCES: Preferences = {
  inAppEnabled: true,
  pushEnabled: true,
  emailEnabled: true,
  smsEnabled: false,
  classReminders: true,
  studyReminders: true,
  resultAlerts: true,
  feeAlerts: true,
  quietHoursStartMin: 22 * 60 + 30,
  quietHoursEndMin: 6 * 60 + 30,
};

/**
 * Which preference toggle governs each category.
 *
 * SYSTEM and PROCTORING have none. A student cannot switch off being told that
 * their session was flagged for review, because being monitored without
 * knowing is the thing the proctoring design exists to prevent.
 */
const PREFERENCE_KEY: Partial<Record<Category, keyof Preferences>> = {
  CLASS_REMINDER: 'classReminders',
  SELF_STUDY_REMINDER: 'studyReminders',
  VIVA_REMINDER: 'studyReminders',
  RESULT: 'resultAlerts',
  FEES: 'feeAlerts',
};

/** Categories that override quiet hours because they are time-critical. */
const URGENT: Set<Category> = new Set(['SYSTEM', 'PROCTORING']);

/** How long an identical notification is suppressed for, per category. */
const DEDUPE_WINDOW_MIN: Record<Category, number> = {
  CLASS_REMINDER: 60,
  SELF_STUDY_REMINDER: 120,
  VIVA_REMINDER: 120,
  HOMEWORK: 720,
  TEST: 720,
  RESULT: 1440,
  ATTENDANCE: 1440,
  // A fee reminder more than once a week is harassment, not a service.
  FEES: 10_080,
  ANNOUNCEMENT: 1440,
  SYSTEM: 5,
  PROCTORING: 60,
};

export interface DispatchRequest {
  category: Category;
  /** Channels the sender would like to use, in order of preference. */
  requested: Channel[];
  /** Minutes from midnight in the recipient's timezone. */
  nowMin: number;
  preferences: Preferences;
  /** Minutes since an identical notification was last sent, if ever. */
  minutesSinceIdentical: number | null;
  /**
   * The self-study blackout. A reminder must not arrive inside it, because the
   * product's own position is that the student should be asleep.
   */
  blackout?: { startMin: number; endMin: number } | undefined;
}

export type DispatchDecision =
  | { send: true; channels: Channel[]; deferToMin: null; reason: string }
  | { send: true; channels: Channel[]; deferToMin: number; reason: string }
  | { send: false; reason: string; suppressedBy: SuppressionReason };

export type SuppressionReason =
  | 'CATEGORY_DISABLED'
  | 'ALL_CHANNELS_DISABLED'
  | 'DUPLICATE'
  | 'IN_BLACKOUT';

function inWindow(nowMin: number, startMin: number, endMin: number): boolean {
  // Windows that cross midnight are the normal case here.
  return startMin <= endMin
    ? nowMin >= startMin && nowMin < endMin
    : nowMin >= startMin || nowMin < endMin;
}

export function isQuiet(nowMin: number, preferences: Preferences): boolean {
  const { quietHoursStartMin: start, quietHoursEndMin: end } = preferences;
  if (start === null || end === null) return false;
  return inWindow(nowMin, start, end);
}

/**
 * Decides whether, how and when to send.
 *
 * A deferred notification is still a send: quiet hours push delivery to the
 * morning rather than dropping it, because a fee reminder that vanishes because
 * it was generated at 23:00 is a bug, not politeness.
 */
export function decideDispatch(request: DispatchRequest): DispatchDecision {
  const { category, preferences } = request;

  const key = PREFERENCE_KEY[category];
  if (key && preferences[key] === false) {
    return {
      send: false,
      reason: `The recipient has turned off ${category.toLowerCase().replace(/_/g, ' ')} notifications.`,
      suppressedBy: 'CATEGORY_DISABLED',
    };
  }

  const window = DEDUPE_WINDOW_MIN[category];
  if (request.minutesSinceIdentical !== null && request.minutesSinceIdentical < window) {
    return {
      send: false,
      reason: `An identical notification was sent ${request.minutesSinceIdentical} minutes ago; the window for this category is ${window}.`,
      suppressedBy: 'DUPLICATE',
    };
  }

  const enabled: Record<Channel, boolean> = {
    IN_APP: preferences.inAppEnabled,
    PUSH: preferences.pushEnabled,
    EMAIL: preferences.emailEnabled,
    SMS: preferences.smsEnabled,
  };

  const channels = request.requested.filter((channel) => enabled[channel]);

  if (channels.length === 0) {
    return {
      send: false,
      reason: 'Every requested channel is switched off for this recipient.',
      suppressedBy: 'ALL_CHANNELS_DISABLED',
    };
  }

  const urgent = URGENT.has(category);

  // The blackout is stronger than quiet hours. Nothing schedules itself into
  // the window the product tells students to be asleep in.
  if (request.blackout && inWindow(request.nowMin, request.blackout.startMin, request.blackout.endMin)) {
    if (!urgent) {
      return {
        send: true,
        channels,
        deferToMin: request.blackout.endMin,
        reason: 'Held until the overnight blackout ends.',
      };
    }
  }

  if (isQuiet(request.nowMin, preferences) && !urgent) {
    // In-app is silent by nature and can land immediately; anything that makes
    // a sound waits for morning.
    const silent = channels.filter((channel) => channel === 'IN_APP');

    if (silent.length > 0) {
      return {
        send: true,
        channels: silent,
        deferToMin: null,
        reason: 'Quiet hours: delivered in-app only, with no push.',
      };
    }

    return {
      send: true,
      channels,
      deferToMin: preferences.quietHoursEndMin ?? 0,
      reason: 'Quiet hours: held until morning.',
    };
  }

  return { send: true, channels, deferToMin: null, reason: 'Delivered now.' };
}

export interface ReminderInput {
  /** Minutes from midnight at which the thing starts. */
  eventStartMin: number;
  /** How far ahead the reminder should land. */
  leadMin: number;
  nowMin: number;
  blackoutEndMin: number;
  cutoffMin: number;
}

/**
 * Places a reminder for a scheduled event.
 *
 * Returns null when there is no honest time to send it. A "your session starts
 * in 15 minutes" notification that arrives after the session started is worse
 * than silence.
 */
export function scheduleReminder(input: ReminderInput): { atMin: number } | null {
  const target = input.eventStartMin - input.leadMin;

  if (target <= input.nowMin) return null;
  if (target >= input.cutoffMin) return null;
  if (target < input.blackoutEndMin) return null;

  return { atMin: target };
}

export interface DigestItem {
  category: Category;
  title: string;
  createdAtMin: number;
}

export interface Digest {
  /** One line summarising everything, for the push. */
  headline: string;
  items: DigestItem[];
  shouldSend: boolean;
}

/**
 * Rolls up low-priority notifications into a single daily summary.
 *
 * Six separate pushes about six pieces of homework is six interruptions for one
 * piece of information. One is enough.
 */
export function buildDigest(items: DigestItem[], minimumToDigest = 3): Digest {
  if (items.length < minimumToDigest) {
    return { headline: '', items, shouldSend: false };
  }

  const counts = new Map<Category, number>();
  for (const item of items) {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }

  const label: Partial<Record<Category, [string, string]>> = {
    HOMEWORK: ['homework task', 'homework tasks'],
    TEST: ['test', 'tests'],
    RESULT: ['result', 'results'],
    ANNOUNCEMENT: ['announcement', 'announcements'],
    ATTENDANCE: ['attendance update', 'attendance updates'],
  };

  const parts = [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([category, count]) => {
      const [singular, plural] = label[category] ?? ['update', 'updates'];
      return `${count} ${count === 1 ? singular : plural}`;
    });

  const headline =
    parts.length === 1
      ? `You have ${parts[0]}.`
      : `You have ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;

  return { headline, items, shouldSend: true };
}

/**
 * The wording of a fee reminder.
 *
 * Kept deliberately plain and non-threatening. The person reading this is
 * usually a parent under financial pressure, and a school's billing messages
 * should not read like a collections agency's.
 */
export function feeReminderCopy(
  outstandingFormatted: string,
  daysOverdue: number,
  studentFirstName: string,
): { title: string; body: string } {
  if (daysOverdue <= 0) {
    return {
      title: `Fee due for ${studentFirstName}`,
      body: `${outstandingFormatted} is due. You can pay through the app or at the office.`,
    };
  }

  if (daysOverdue <= 14) {
    return {
      title: `Fee reminder for ${studentFirstName}`,
      body: `${outstandingFormatted} was due ${daysOverdue} days ago. If there is a difficulty, please speak to the office; arrangements can usually be made.`,
    };
  }

  return {
    title: `Fee outstanding for ${studentFirstName}`,
    body: `${outstandingFormatted} has been outstanding for ${daysOverdue} days. Please contact the office so we can sort this out together.`,
  };
}
