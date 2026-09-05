import { formatMinutes, formatRange, subjectColor } from '../lib/format';
import type { ClassBlock, StudyBlock } from '../types/api';

/**
 * The day rail.
 *
 * This is the one screen element that carries the product's whole thesis: a
 * lecture in the afternoon *causes* a study block in the evening, by rule. So
 * classes sit on the upper track, self-study on the lower one, and a curve
 * drops from each class to the block it produced. You can see the causation
 * rather than read about it.
 *
 * The shaded tail is the overnight blackout — the hours the product itself says
 * a student should not be studying. Showing it makes the policy visible instead
 * of leaving it as an error message the student meets at 21:31.
 */
const DAY_START = 7 * 60;
const DAY_END = 23 * 60;
const SPAN = DAY_END - DAY_START;

function toPercent(minute: number): number {
  return ((Math.max(DAY_START, Math.min(DAY_END, minute)) - DAY_START) / SPAN) * 100;
}

interface Props {
  classes: ClassBlock[];
  study: StudyBlock[];
  nowMinutes: number;
  /** Minute the overnight blackout begins. Comes from the institute's policy. */
  cutoffMin?: number;
}

export function DayRail({ classes, study, nowMinutes, cutoffMin = 21 * 60 + 30 }: Props) {
  const hours = [8, 11, 14, 17, 20, 23];
  const showNow = nowMinutes >= DAY_START && nowMinutes <= DAY_END;

  // A study block is linked to the class it came from, so the curve knows where
  // to start. Only same-day links can be drawn; a next-day block has no class
  // above it on this rail, which is itself informative.
  const links = study
    .map((block) => {
      const source = classes.find((item) => item.subject.name === block.classSession?.subject.name);
      if (!source) return null;
      return {
        fromPct: toPercent((source.startTimeMin + source.endTimeMin) / 2),
        toPct: toPercent((block.plannedStartMin + block.plannedEndMin) / 2),
      };
    })
    .filter((link): link is { fromPct: number; toPct: number } => link !== null);

  return (
    <div className="px-5 py-4">
      <div className="relative">
        {/* ---------- upper track: classes ---------- */}
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted">
          Class
        </div>
        <div className="relative h-12 rounded-lg bg-surface-sunken">
          {classes.length === 0 ? (
            <p className="absolute inset-0 flex items-center justify-center text-[12.5px] text-ink-muted">
              No class today
            </p>
          ) : null}

          {classes.map((item) => {
            const left = toPercent(item.startTimeMin);
            const width = Math.max(4, toPercent(item.endTimeMin) - left);
            const colour = subjectColor(item.subject.colorHex);

            return (
              <div
                key={item.id}
                title={`${item.subject.name} · ${formatRange(item.startTimeMin, item.endTimeMin)}`}
                style={{ left: `${left}%`, width: `${width}%`, backgroundColor: colour }}
                className="absolute top-1 flex h-10 items-center overflow-hidden rounded-md px-2 text-white"
              >
                <span className="truncate text-[12px] font-semibold">{item.subject.name}</span>
              </div>
            );
          })}
        </div>

        {/* ---------- the curves ---------- */}
        <svg
          aria-hidden
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="h-8 w-full"
        >
          {links.map((link, index) => (
            <path
              key={index}
              d={`M ${link.fromPct} 0 C ${link.fromPct} 60, ${link.toPct} 40, ${link.toPct} 100`}
              fill="none"
              stroke="var(--brand)"
              strokeWidth="0.6"
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        {/* ---------- lower track: self-study ---------- */}
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-brand-deep">
          Self-study
        </div>
        <div className="relative h-12 overflow-hidden rounded-lg bg-surface-sunken">
          {/* blackout tail */}
          <div
            aria-hidden
            style={{ left: `${toPercent(cutoffMin)}%`, right: 0 }}
            className="absolute inset-y-0 bg-ink/[0.07]"
            title={`No new sessions after ${formatMinutes(cutoffMin)}`}
          />

          {study.length === 0 ? (
            <p className="absolute inset-0 flex items-center justify-center text-[12.5px] text-ink-muted">
              Nothing scheduled today
            </p>
          ) : null}

          {study.map((block) => {
            const left = toPercent(block.plannedStartMin);
            const width = Math.max(4, toPercent(block.plannedEndMin) - left);
            const done = block.status === 'COMPLETED';

            return (
              <div
                key={block.id}
                title={`${block.classSession?.subject.name ?? 'Study'} · ${formatRange(
                  block.plannedStartMin,
                  block.plannedEndMin,
                )}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                className={
                  done
                    ? 'absolute top-1 flex h-10 items-center overflow-hidden rounded-md bg-brand px-2 text-white'
                    : 'absolute top-1 flex h-10 items-center overflow-hidden rounded-md border-2 border-dashed border-brand bg-brand-tint px-2 text-brand-deep'
                }
              >
                <span className="truncate text-[12px] font-semibold">
                  {block.classSession?.subject.name ?? 'Study'}
                </span>
              </div>
            );
          })}
        </div>

        {/* ---------- now marker, spanning both tracks ---------- */}
        {showNow ? (
          <div
            aria-hidden
            style={{ left: `${toPercent(nowMinutes)}%` }}
            className="pointer-events-none absolute top-4 bottom-6 w-px bg-accent"
          >
            <span className="absolute -top-1 -left-1 h-2 w-2 rounded-full bg-accent" />
          </div>
        ) : null}

        {/* ---------- hour scale ---------- */}
        <div className="relative mt-1.5 h-4">
          {hours.map((hour) => (
            <span
              key={hour}
              style={{ left: `${toPercent(hour * 60)}%` }}
              className="absolute -translate-x-1/2 font-mono text-[10px] tabular-nums text-ink-muted"
            >
              {formatMinutes(hour * 60)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
