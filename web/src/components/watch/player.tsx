import { useState } from "react";
import { Pause, Play } from "lucide-react";
import type { SegmentBundle } from "@/components/watch/bundle";
import { SIGNAL_COLOR, SIGNAL_LABEL, formatTime } from "@/components/localize/format";
import { cn } from "@/lib/utils";

/**
 * The design's player: the lecture's frame with the English line on the left
 * of a wipe and the Hindi line on the right; moving the pointer across the
 * frame moves the wipe. Clicking the frame plays and pauses whichever language
 * is selected below it. Under the frame, the lesson as coloured bands with a
 * playhead; a band seeks to its segment.
 */
export function Player({
  media,
  poster,
  hasVideo,
  segments,
  current,
  playheadSec,
  durationSec,
  nowSec,
  isPlaying,
  hindiReady,
  language,
  onLanguage,
  onToggle,
  onJump,
  footer,
}: {
  /** The two media elements, owned by the watch view; only the active one is shown. */
  media: React.ReactNode;
  /** A frame of the footage for an audio-only job's frame, or null for a plain panel. */
  poster: string | null;
  /** The job has footage of its own, shown in the frame by `media`. */
  hasVideo: boolean;
  segments: SegmentBundle[];
  /** The segment whose lines are on screen. */
  current: SegmentBundle | undefined;
  /** The playhead in SOURCE time, or null when nothing is playing. */
  playheadSec: number | null;
  durationSec: number;
  nowSec: number;
  isPlaying: boolean;
  hindiReady: boolean;
  language: "source" | "output";
  onLanguage: (next: "source" | "output") => void;
  onToggle: () => void;
  onJump: (entry: SegmentBundle) => void;
  footer: React.ReactNode;
}) {
  const [split, setSplit] = useState(50);
  const english = current?.source.text ?? "";
  const hindi = current?.adapted?.targetText ?? "";

  return (
    <div>
      <div
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setSplit(
            Math.max(4, Math.min(96, ((event.clientX - rect.left) / rect.width) * 100))
          );
        }}
        className="relative aspect-video cursor-ew-resize overflow-hidden bg-panel-2"
        style={
          poster === null
            ? undefined
            : { background: `#141507 url(${poster}) center/cover no-repeat` }
        }
      >
        {poster === null && !hasVideo ? (
          // An audio-only lecture has no picture: the brand's film, dimmed, so
          // the frame still carries the two lines.
          <video
            src="/nua/assets/nua-flower.mp4"
            autoPlay
            muted
            loop
            playsInline
            aria-hidden
            className="absolute inset-0 size-full object-cover object-[40%_50%] opacity-35"
          />
        ) : null}
        {media}
        <button
          type="button"
          onClick={onToggle}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="absolute inset-0 z-1 cursor-ew-resize nua-focus"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,rgba(13,13,3,.35),rgba(13,13,3,0)_18%,rgba(13,13,3,0)_70%,rgba(13,13,3,.45))]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-ink/18"
          style={{ clipPath: `inset(0 0 0 ${split}%)` }}
        />
        <span className="nua-caps pointer-events-none absolute top-[18px] left-5 text-[12px] text-[#fff3e6]">
          English original
        </span>
        <span className="nua-caps pointer-events-none absolute top-[18px] right-5 text-[12px] text-[#fff3e6]">
          Hindi, voiced by Nua
        </span>
        <span className="pointer-events-none absolute top-[18px] left-1/2 -translate-x-1/2 text-[12px] tabular-nums text-[#fff3e6]">
          {formatTime(nowSec)} / {formatTime(durationSec)}
        </span>

        {english === "" ? null : (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-[max(24px,4vw)] z-2 flex justify-center px-6"
            style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
          >
            <span className="max-w-[900px] bg-ink/82 px-4 py-2.5 text-center text-[max(15px,1.5vw)] leading-[1.4] text-[#fff3e6]">
              {english}
            </span>
          </div>
        )}
        {hindi === "" ? null : (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-[max(24px,4vw)] z-2 flex justify-center px-6"
            style={{ clipPath: `inset(0 0 0 ${split}%)` }}
          >
            <span
              lang="hi"
              className="max-w-[900px] bg-ink/82 px-4 py-2.5 text-center text-[max(16px,1.65vw)] leading-[1.4] text-[#fff3e6]"
            >
              {hindi}
            </span>
          </div>
        )}

        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 z-2 w-px bg-cream"
          style={{ left: `${split}%` }}
        >
          <div className="absolute top-1/2 -left-6 -mt-6 flex size-12 items-center justify-center bg-cream text-[12px] font-medium text-ink">
            EN|HI
          </div>
        </div>
      </div>

      <div className="relative mt-[3px] flex h-[14px] gap-[3px]">
        {segments.map((entry, index) => {
          const next = segments[index + 1]?.source.startSec ?? entry.source.endSec;
          return (
            <button
              key={entry.source.id}
              type="button"
              onClick={() => onJump(entry)}
              title={`${SIGNAL_LABEL[entry.source.signal]} · ${formatTime(entry.source.startSec)}`}
              aria-label={`Play from segment ${index + 1}, ${SIGNAL_LABEL[entry.source.signal]}, at ${formatTime(entry.source.startSec)}`}
              className="min-w-[2px] transition-opacity hover:opacity-80 nua-focus"
              style={{
                flex: `${Math.max(0.1, next - entry.source.startSec)} 1 0px`,
                background: SIGNAL_COLOR[entry.source.signal],
              }}
            />
          );
        })}
        {playheadSec === null || durationSec <= 0 ? null : (
          <div
            aria-hidden
            className="pointer-events-none absolute -top-1 -bottom-1 w-0.5 bg-white"
            style={{ left: `${Math.min(100, (playheadSec / durationSec) * 100)}%` }}
          />
        )}
      </div>

      <div className="mt-[22px] flex flex-wrap items-center gap-x-6 gap-y-4">
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onToggle}
            className="nua-btn w-12 px-0"
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
          <div role="group" aria-label="Listen in" className="flex gap-2.5">
            <button
              type="button"
              aria-pressed={language === "source"}
              onClick={() => onLanguage("source")}
              className="nua-btn nua-btn-outline"
            >
              English
            </button>
            <button
              type="button"
              aria-pressed={language === "output"}
              disabled={!hindiReady}
              onClick={() => onLanguage("output")}
              className={cn(
                "nua-btn nua-btn-outline",
                !hindiReady && "pointer-events-none"
              )}
            >
              Hindi
            </button>
          </div>
        </div>
        {footer}
      </div>
    </div>
  );
}
