import { describe, expect, it } from 'vitest';
import {
  buildDigest,
  decideDispatch,
  DEFAULT_PREFERENCES,
  feeReminderCopy,
  isQuiet,
  scheduleReminder,
  type Preferences,
} from '../modules/notifications/dispatch.rules';

const prefs = (overrides: Partial<Preferences> = {}): Preferences => ({ ...DEFAULT_PREFERENCES, ...overrides });

const decide = (overrides: Partial<Parameters<typeof decideDispatch>[0]> = {}) =>
  decideDispatch({
    category: 'HOMEWORK',
    requested: ['PUSH', 'IN_APP'],
    nowMin: 10 * 60,
    preferences: prefs(),
    minutesSinceIdentical: null,
    ...overrides,
  });

describe('preferences are respected', () => {
  it('sends a normal notification', () => {
    expect(decide().send).toBe(true);
  });

  it('suppresses a category the recipient turned off', () => {
    const result = decide({ category: 'FEES', preferences: prefs({ feeAlerts: false }) });
    expect(result.send).toBe(false);
    expect(result.send === false && result.suppressedBy).toBe('CATEGORY_DISABLED');
  });

  it('filters out disabled channels', () => {
    const result = decide({ preferences: prefs({ pushEnabled: false }) });
    expect(result.send === true && result.channels).toEqual(['IN_APP']);
  });

  it('suppresses when every channel is off', () => {
    const result = decide({ preferences: prefs({ pushEnabled: false, inAppEnabled: false }) });
    expect(result.send === false && result.suppressedBy).toBe('ALL_CHANNELS_DISABLED');
  });

  it.each(['SYSTEM', 'PROCTORING'] as const)('never lets %s be switched off', (category) => {
    expect(decide({ category, preferences: prefs({ pushEnabled: false }) }).send).toBe(true);
  });
});

describe('deduplication', () => {
  it('suppresses an identical notification inside the window', () => {
    const result = decide({ minutesSinceIdentical: 30 });
    expect(result.send === false && result.suppressedBy).toBe('DUPLICATE');
  });

  it('allows it once the window has passed', () => {
    expect(decide({ minutesSinceIdentical: 800 }).send).toBe(true);
  });

  it('holds fee reminders to one a week', () => {
    expect(decide({ category: 'FEES', minutesSinceIdentical: 5000 }).send).toBe(false);
    expect(decide({ category: 'FEES', minutesSinceIdentical: 11_000 }).send).toBe(true);
  });
});

describe('quiet hours', () => {
  it.each([
    [23 * 60, true],
    [2 * 60, true],
    [10 * 60, false],
    [6 * 60 + 30, false],
  ])('at %i minutes quiet is %s', (minute, expected) => {
    expect(isQuiet(minute, prefs())).toBe(expected);
  });

  it('drops push but keeps in-app', () => {
    const result = decide({ nowMin: 23 * 60 });
    expect(result.send === true && result.channels).toEqual(['IN_APP']);
  });

  it('defers a push-only notification to the morning', () => {
    const result = decide({ nowMin: 23 * 60, requested: ['PUSH'] });
    expect(result.send === true && result.deferToMin).toBe(6 * 60 + 30);
  });

  it('lets urgent notifications through', () => {
    const result = decide({ category: 'SYSTEM', nowMin: 23 * 60, requested: ['PUSH'] });
    expect(result.send === true && result.deferToMin).toBeNull();
  });
});

describe('the study blackout', () => {
  const blackout = { startMin: 21 * 60 + 30, endMin: 30 };

  it('holds anything generated inside it', () => {
    const result = decide({ nowMin: 22 * 60, requested: ['PUSH'], blackout });
    expect(result.send === true && result.deferToMin).toBe(30);
  });

  it('leaves daytime notifications alone', () => {
    const result = decide({ nowMin: 10 * 60, blackout });
    expect(result.send === true && result.deferToMin).toBeNull();
  });
});

describe('reminder placement', () => {
  it('places a reminder ahead of the event', () => {
    const result = scheduleReminder({ eventStartMin: 19 * 60, leadMin: 15, nowMin: 10 * 60, blackoutEndMin: 30, cutoffMin: 21 * 60 + 30 });
    expect(result?.atMin).toBe(18 * 60 + 45);
  });

  it.each([
    [{ eventStartMin: 9 * 60, leadMin: 15, nowMin: 10 * 60 }, 'the event has passed'],
    [{ eventStartMin: 22 * 60, leadMin: 15, nowMin: 10 * 60 }, 'it would land after the cutoff'],
  ])('sends nothing when %o', (partial) => {
    expect(scheduleReminder({ ...partial, blackoutEndMin: 30, cutoffMin: 21 * 60 + 30 })).toBeNull();
  });
});

describe('digest', () => {
  const items = [
    { category: 'HOMEWORK' as const, title: 'Physics', createdAtMin: 100 },
    { category: 'HOMEWORK' as const, title: 'Maths', createdAtMin: 120 },
    { category: 'TEST' as const, title: 'Unit test', createdAtMin: 140 },
  ];

  it('rolls three items into one message', () => {
    const digest = buildDigest(items);
    expect(digest.shouldSend).toBe(true);
    expect(digest.headline).toBe('You have 2 homework tasks and 1 test.');
  });

  it('does not digest two items', () => {
    expect(buildDigest(items.slice(0, 2)).shouldSend).toBe(false);
  });
});

describe('fee reminder wording', () => {
  it.each([0, 10, 60])('at %i days overdue it stays non-threatening', (days) => {
    const copy = feeReminderCopy('\u20b95,000.00', days, 'Aarav');
    expect(copy.body).not.toMatch(/penalty|legal|action will be taken|debt/i);
  });

  it('offers help once a payment is late', () => {
    expect(feeReminderCopy('\u20b95,000.00', 10, 'Aarav').body).toContain('arrangements can usually be made');
  });
});
