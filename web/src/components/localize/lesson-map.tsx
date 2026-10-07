import type { PedagogicalSignal } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";
import {
  SIGNAL_BAND,
  SIGNAL_LABEL,
  SIGNAL_MEANING,
  formatTime,
} from "@/components/localize/format";

export interface MapSegment {
  id: string;
  startSec: number;
  endSec: number;
  signal: PedagogicalSignal;
}

/**
 * The shape of the lesson: one band per segment across the source clip,
 * coloured by the instructional move stage 1 heard, with a playhead.
 *
 * It is the whole product's claim in one glance — the model did not just
 * transcribe, it found where the teacher defined, warned and recapped — so it
 * leads the job page and the landing page. Without `onSelect` it is a picture;
 * with it, each band is a button that opens that segment's reasoning.
 */
export function LessonMap({
  segments,
  selectedId,
  onSelect,
  playheadSec,
  showLegend = true,
  className,
}: {
  segments: MapSegment[];
  selectedId?: string | undefined;
  onSelect?: (id: string) => void;
  /** Position in SOURCE time; null hides the playhead. */
  playheadSec?: number | null;
  showLegend?: boolean;
  className?: string;
}) {
  const first = segments[0];
  const last = segments.at(-1);
  if (first === undefined || last === undefined) return null;

  const origin = first.startSec;
  const span = Math.max(last.endSec - origin, 0.001);
  const present = [...new Set(segments.map((segment) => segment.signal))];

  return (
    <div className={cn("grid gap-2", className)}>
      <div className="relative">
        <ol className="flex h-9 gap-0.5" aria-label="Lesson map">
          {segments.map((segment, index) => {
            const width = ((segment.endSec - segment.startSec) / span) * 100;
            // The teacher's pause before this segment, drawn as the space it
            // took. Without it every band after a pause sits left of its own
            // time, and the playhead — placed by time — drifts off the bands.
            const before = index === 0 ? origin : (segments[index - 1]?.endSec ?? origin);
            const lead = (Math.max(segment.startSec - before, 0) / span) * 100;
            const label = `${SIGNAL_LABEL[segment.signal]}, ${formatTime(segment.startSec)} to ${formatTime(segment.endSec)}`;
            const active = segment.id === selectedId;
            const band = cn(
              "block h-full w-full rounded-[3px] transition-[opacity,transform]",
              SIGNAL_BAND[segment.signal],
              selectedId !== undefined && !active && "opacity-45",
              active && "ring-2 ring-foreground ring-offset-2 ring-offset-background"
            );

            return (
              <li
                key={segment.id}
                style={{ width: `${width}%`, marginLeft: `${lead}%` }}
                className="min-w-1"
              >
                {onSelect === undefined ? (
                  <span className={band} title={label} />
                ) : (
                  <button
                    type="button"
                    title={label}
                    aria-label={label}
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSelect(segment.id)}
                    className={cn(band, "hover:opacity-100 focus-visible:opacity-100")}
                  />
                )}
              </li>
            );
          })}
        </ol>
        {playheadSec === null || playheadSec === undefined ? null : (
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-y-1 w-0.5 rounded-full bg-foreground"
            style={{
              left: `${Math.min(Math.max((playheadSec - origin) / span, 0), 1) * 100}%`,
            }}
          />
        )}
      </div>

      <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
        <span>{formatTime(origin)}</span>
        <span>{formatTime(last.endSec)}</span>
      </div>

      {showLegend ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          {present.map((signal) => (
            <li
              key={signal}
              className="flex items-center gap-1.5"
              title={SIGNAL_MEANING[signal]}
            >
              <span
                className={cn("size-2.5 rounded-sm", SIGNAL_BAND[signal])}
                aria-hidden
              />
              {SIGNAL_LABEL[signal]}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
