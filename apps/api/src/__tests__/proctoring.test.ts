import { describe, expect, it } from 'vitest';
import {
  canStartMonitored,
  coalesce,
  CONSENT_VERSION,
  EVENT_PROFILES,
  PROCTORING_DISCLAIMER,
  severityFor,
  studentNotice,
  summarise,
  type EventType,
  type RawEvent,
} from '../modules/proctoring/proctoring.signals';

const allTypes = Object.keys(EVENT_PROFILES) as EventType[];

describe('the catalogue refuses to accuse', () => {
  it('gives every event an innocent explanation', () => {
    for (const type of allTypes) {
      expect(EVENT_PROFILES[type].benignExplanation.length).toBeGreaterThan(10);
    }
  });

  it('never assigns HIGH severity automatically', () => {
    for (const type of allTypes) {
      expect(EVENT_PROFILES[type].baseSeverity).not.toBe('HIGH');
      expect(severityFor(type, 600_000)).not.toBe('HIGH');
    }
  });

  it('tells the student in language that does not accuse them', () => {
    for (const type of allTypes) {
      expect(studentNotice(type)).not.toMatch(/cheat|suspicious|violation|malpractice/i);
    }
  });
});

describe('severity escalates with duration, within limits', () => {
  it('keeps a brief absence low', () => {
    expect(severityFor('FACE_NOT_DETECTED', 2000)).toBe('LOW');
  });

  it('raises a sustained absence to medium', () => {
    expect(severityFor('FACE_NOT_DETECTED', 30_000)).toBe('MEDIUM');
  });

  it('leaves informational events alone', () => {
    expect(severityFor('NETWORK_LOST', 600_000)).toBe('INFO');
  });
});

describe('coalescing a noisy detector', () => {
  it('collapses a burst into a single observation', () => {
    const burst: RawEvent[] = Array.from({ length: 50 }, (_, i) => ({
      type: 'FACE_NOT_DETECTED',
      occurredAt: 1000 + i * 200,
      durationMs: 200,
    }));

    const merged = coalesce(burst);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.durationMs).toBeGreaterThan(9000);
  });

  it('keeps genuinely separate occurrences apart', () => {
    const events: RawEvent[] = [
      { type: 'TAB_HIDDEN', occurredAt: 0, durationMs: 1000 },
      { type: 'TAB_HIDDEN', occurredAt: 60_000, durationMs: 1000 },
    ];
    expect(coalesce(events)).toHaveLength(2);
  });

  it('never merges different event types', () => {
    const events: RawEvent[] = [
      { type: 'TAB_HIDDEN', occurredAt: 0, durationMs: 100 },
      { type: 'WINDOW_BLUR', occurredAt: 100, durationMs: 100 },
    ];
    expect(coalesce(events)).toHaveLength(2);
  });
});

describe('the session summary', () => {
  it('attaches the disclaimer to every summary', () => {
    expect(summarise([], 900_000).disclaimer).toBe(PROCTORING_DISCLAIMER);
    expect(PROCTORING_DISCLAIMER).toContain('not findings');
  });

  it('does not suggest review for a clean session', () => {
    expect(summarise([], 900_000).reviewSuggested).toBe(false);
  });

  it('does not suggest review for ordinary glancing away', () => {
    const glances: RawEvent[] = Array.from({ length: 8 }, (_, i) => ({
      type: 'FACE_NOT_DETECTED',
      occurredAt: i * 60_000,
      durationMs: 4000,
    }));
    expect(summarise(glances, 900_000).reviewSuggested).toBe(false);
  });

  it('does suggest review for a sustained pattern, without accusing', () => {
    const events: RawEvent[] = [
      { type: 'MULTIPLE_FACES', occurredAt: 0, durationMs: 15_000 },
      { type: 'MULTIPLE_FACES', occurredAt: 100_000, durationMs: 15_000 },
      { type: 'MULTIPLE_FACES', occurredAt: 300_000, durationMs: 15_000 },
    ];

    const summary = summarise(events, 900_000);
    expect(summary.reviewSuggested).toBe(true);
    expect(summary.reviewReason).toContain('not an accusation');
    expect(summary.observations[0]?.benignExplanation).toContain('family member');
  });

  it('treats a dark session as poor data rather than as evidence', () => {
    const summary = summarise([{ type: 'CAMERA_STOPPED', occurredAt: 0, durationMs: 800_000 }], 900_000);
    expect(summary.dataQuality).toBe('POOR');
    expect(summary.reviewSuggested).toBe(false);
  });

  it('raises the bar for review when the data is poor', () => {
    const poor = summarise(
      [
        { type: 'CAMERA_STOPPED', occurredAt: 0, durationMs: 800_000 },
        { type: 'PASTE_DETECTED', occurredAt: 10, durationMs: 0 },
        { type: 'PASTE_DETECTED', occurredAt: 20_000, durationMs: 0 },
      ],
      900_000,
    );
    expect(poor.reviewSuggested).toBe(false);

    const good = summarise(
      [
        { type: 'PASTE_DETECTED', occurredAt: 0, durationMs: 0 },
        { type: 'PASTE_DETECTED', occurredAt: 20_000, durationMs: 0 },
      ],
      900_000,
    );
    expect(good.reviewSuggested).toBe(true);
  });

  it('computes percentages and survives a zero-length session', () => {
    expect(summarise([{ type: 'TAB_HIDDEN', occurredAt: 0, durationMs: 90_000 }], 900_000).awayPct).toBe(10);
    expect(Number.isFinite(summarise([], 0).awayPct)).toBe(true);
  });
});

describe('consent', () => {
  const granted = {
    cameraGranted: true,
    microphoneGranted: true,
    consentVersion: CONSENT_VERSION,
    consentGivenAt: Date.now(),
  };

  it('allows a monitored session once consent is given', () => {
    expect(canStartMonitored(granted, true, true).allowed).toBe(true);
  });

  it('refuses without consent', () => {
    expect(canStartMonitored({ ...granted, consentGivenAt: null }, true, true).allowed).toBe(false);
  });

  it('refuses consent given under older terms', () => {
    expect(canStartMonitored({ ...granted, consentVersion: '2020-old' }, true, true).allowed).toBe(false);
  });

  it('offers an unmonitored session when the camera is declined', () => {
    const result = canStartMonitored({ ...granted, cameraGranted: false }, true, false);
    expect(result.allowed).toBe(false);
    expect(result.proceedUnmonitored).toBe(true);
  });

  it('offers a typed viva when the microphone is declined', () => {
    expect(canStartMonitored({ ...granted, microphoneGranted: false }, false, true).proceedUnmonitored).toBe(true);
  });
});
