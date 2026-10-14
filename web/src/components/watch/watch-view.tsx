"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { audioUrl, getJob, posterUrl, videoUrl } from "@/lib/api/localize";
import type { Job, JobStatus } from "@/lib/api/schemas";
import { ProgressSteps } from "@/components/localize/progress-steps";
import { Scramble } from "@/components/nua/scramble";
import { AdaptView } from "@/components/watch/adapt-view";
import { bundle, failedAt, locate, type SegmentBundle } from "@/components/watch/bundle";
import { LessonLayers } from "@/components/watch/lesson-layers";
import { Player } from "@/components/watch/player";
import { cn } from "@/lib/utils";

const POLL_MS = 2_000;
const TERMINAL: JobStatus[] = ["done", "failed"];

/**
 * The watch page, from upload to reasoning, in the designer's layout: the
 * player, then the lesson either as two layers of text or as five steps per
 * segment.
 *
 * Polls while the job runs and renders whatever exists at each poll, because
 * the API writes every stage's output as it finishes: the segments appear with
 * the analysis, fill with Hindi during adapt, gain scores after the critique,
 * and the Hindi track arrives last.
 */
export function WatchView({
  initialJob,
  demo = false,
}: {
  initialJob: Job;
  demo?: boolean;
}) {
  const [job, setJob] = useState(initialJob);
  const [pollError, setPollError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"adapt" | "lesson">("adapt");
  const [playing, setPlaying] = useState<{ id: string; sourceSec: number } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [nowSec, setNowSec] = useState(0);
  const [language, setLanguage] = useState<"source" | "output">(
    initialJob.synthesis === null ? "source" : "output"
  );
  // Whether the viewer has picked a language. Until they do, the page switches
  // to the Hindi the moment it lands, which is what they came for.
  const languageChosen = useRef(false);
  const hindiLanded = job.synthesis !== null;
  useEffect(() => {
    if (hindiLanded && !languageChosen.current) setLanguage("output");
  }, [hindiLanded]);

  // Media elements, not audio elements: a job made from an mp4 plays <video>,
  // and everything below (seek, stop-at, playhead) is the same API on both.
  const sourceMedia = useRef<HTMLMediaElement>(null);
  const outputMedia = useRef<HTMLMediaElement>(null);
  const stopAt = useRef<{
    element: HTMLMediaElement;
    startSec: number;
    endSec: number;
  } | null>(null);

  useEffect(() => {
    if (TERMINAL.includes(job.status) || demo) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      getJob(job.id, controller.signal)
        .then((next) => {
          setJob(next);
          setPollError(null);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          // Keep polling: one failed poll on a flaky connection is not a failed job.
          setPollError(error instanceof Error ? error.message : "Could not refresh");
          setJob((current) => ({ ...current }));
        });
    }, POLL_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [job, demo]);

  const segments = useMemo(() => bundle(job), [job]);
  const selectedIndex = Math.max(
    segments.findIndex((entry) => entry.source.id === selectedId),
    0
  );
  const shown =
    segments.find((entry) => entry.source.id === playing?.id) ?? segments[selectedIndex];

  const active = () =>
    language === "source" ? sourceMedia.current : outputMedia.current;

  /** Plays one segment of one track: seek, play, and pause at the segment's end. */
  const playSegment = (entry: SegmentBundle, which: "source" | "output") => {
    const element = which === "source" ? sourceMedia.current : outputMedia.current;
    const other = which === "source" ? outputMedia.current : sourceMedia.current;
    if (element === null) return;
    const start = which === "source" ? entry.source.startSec : entry.output?.startSec;
    const length =
      which === "source"
        ? entry.source.endSec - entry.source.startSec
        : entry.output?.lengthSec;
    if (start === undefined || length === undefined) return;
    other?.pause();
    languageChosen.current = true;
    setLanguage(which);
    element.currentTime = start;
    stopAt.current = { element, startSec: start, endSec: start + length };
    void element.play();
  };

  /**
   * The language switch. Stage 5 lays the Hindi on the English timeline, so
   * the same second in the other track is the same moment of the lesson:
   * switching mid-sentence carries on from there, playing if it was playing.
   */
  const switchLanguage = (next: "source" | "output") => {
    languageChosen.current = true;
    if (next === language) return;
    const from = active();
    const to = next === "source" ? sourceMedia.current : outputMedia.current;
    setLanguage(next);
    if (from === null || to === null) return;
    const wasPlaying = !from.paused;
    from.pause();
    stopAt.current = null;
    to.currentTime = Math.min(
      from.currentTime,
      Number.isFinite(to.duration) ? to.duration : Infinity
    );
    if (wasPlaying) void to.play();
  };

  /** A band or a line of the transcript: jump there in the language on screen and play on. */
  const jumpTo = (entry: SegmentBundle) => {
    const start = language === "source" ? entry.source.startSec : entry.output?.startSec;
    if (start !== undefined) seek(start);
  };

  const seek = (sec: number) => {
    const element = active();
    if (element === null) return;
    stopAt.current = null;
    element.currentTime = sec;
    void element.play();
  };

  const toggle = () => {
    const element = active();
    if (element === null) return;
    if (element.paused) void element.play();
    else element.pause();
  };

  /**
   * Two jobs on every tick. First, stop a segment play at the segment's end —
   * but only while the playhead is still inside that segment, or a stop point
   * outlives the play it was set for. Second, move the playhead, the subtitles
   * and the selection.
   */
  const onTimeUpdate = (
    event: React.SyntheticEvent<HTMLMediaElement>,
    track: "source" | "output"
  ) => {
    const element = event.currentTarget;
    const now = element.currentTime;
    const target = stopAt.current;
    if (target !== null && element === target.element) {
      // timeupdate fires every ~250 ms, so allow that much slack past the end.
      const SLACK_SEC = 0.5;
      if (now < target.startSec - SLACK_SEC || now > target.endSec + SLACK_SEC) {
        stopAt.current = null;
      } else if (now >= target.endSec) {
        element.pause();
        stopAt.current = null;
      }
    }
    if (track === language) setNowSec(now);
    if (element.paused) return;
    const at = locate(segments, track, now);
    setPlaying(at);
    if (at !== null && at.id !== selectedId) setSelectedId(at.id);
  };

  const onPlay = (track: "source" | "output") => {
    // Only one track at a time: the two are different languages over the same idea.
    (track === "source" ? outputMedia.current : sourceMedia.current)?.pause();
    if (track === language) setIsPlaying(true);
  };

  const onPause = (
    event: React.SyntheticEvent<HTMLMediaElement>,
    track: "source" | "output"
  ) => {
    if (stopAt.current?.element === event.currentTarget) stopAt.current = null;
    if (track === language) setIsPlaying(false);
  };

  const { analysis, adaptation, critique, synthesis, corroboration } = job;
  const hasVideo = job.sourceVideoUri !== null;
  const hindiReady = synthesis !== null;
  const durationSec =
    job.sourceDurationSec ??
    analysis?.segments.at(-1)?.endSec ??
    synthesis?.durationSec ??
    0;
  const hindiDownload = hindiReady
    ? `${job.outputVideoUri === null ? audioUrl(job, "output", { demo }) : videoUrl(job, "output", { demo })}?download=1`
    : null;
  const totals = job.calls.reduce(
    (sum, call) => ({
      tokens: sum.tokens + call.inputTokens + call.outputTokens + call.thoughtTokens,
      latencyMs: sum.latencyMs + call.latencyMs,
    }),
    { tokens: 0, latencyMs: 0 }
  );

  const media = (
    <>
      {hasVideo ? (
        <video
          ref={sourceMedia as React.RefObject<never>}
          preload="metadata"
          onTimeUpdate={(event) => onTimeUpdate(event, "source")}
          onPlay={() => onPlay("source")}
          onPause={(event) => onPause(event, "source")}
          playsInline
          src={videoUrl(job, "source", { demo })}
          className={cn(
            "absolute inset-0 size-full bg-black object-contain",
            language !== "source" && "hidden"
          )}
        />
      ) : (
        <audio
          ref={sourceMedia as React.RefObject<never>}
          preload="metadata"
          onTimeUpdate={(event) => onTimeUpdate(event, "source")}
          onPlay={() => onPlay("source")}
          onPause={(event) => onPause(event, "source")}
          src={audioUrl(job, "source", { demo })}
          className="hidden"
        />
      )}
      {!hindiReady ? null : job.outputVideoUri !== null ? (
        <video
          ref={outputMedia as React.RefObject<never>}
          preload="metadata"
          onTimeUpdate={(event) => onTimeUpdate(event, "output")}
          onPlay={() => onPlay("output")}
          onPause={(event) => onPause(event, "output")}
          playsInline
          src={videoUrl(job, "output", { demo })}
          className={cn(
            "absolute inset-0 size-full bg-black object-contain",
            language !== "output" && "hidden"
          )}
        />
      ) : (
        <audio
          ref={outputMedia as React.RefObject<never>}
          preload="metadata"
          onTimeUpdate={(event) => onTimeUpdate(event, "output")}
          onPlay={() => onPlay("output")}
          onPause={(event) => onPause(event, "output")}
          src={audioUrl(job, "output", { demo })}
          className="hidden"
        />
      )}
    </>
  );

  const retried = job.retriedIds?.length ?? 0;
  const confirmed = corroboration?.supportedByEnergy;
  const scores = [
    critique === null ? null : ["Fidelity", critique.overallFidelity, "/ 100"],
    critique === null ? null : ["Naturalness", critique.overallNaturalness, "/ 100"],
    corroboration === null || confirmed === undefined
      ? null
      : ["Stress confirmed", confirmed, `of ${corroboration.emphasisChecks.length}`],
    critique === null ? null : ["Rewritten", retried, `of ${segments.length}`],
  ].filter((score): score is [string, number, string] => score !== null);

  const hood = (
    <div className="mt-5 flex flex-wrap items-start justify-between gap-4 text-[14px] text-stone">
      {job.calls.length === 0 ? (
        <span />
      ) : (
        <details className="max-w-xl">
          <summary className="cursor-pointer hover:text-cream">
            Under the hood: {job.calls.length} Gemini calls,{" "}
            {(totals.latencyMs / 1000).toFixed(0)} s of model time,{" "}
            {totals.tokens.toLocaleString()} tokens
            {synthesis === null
              ? ""
              : `, ${synthesis.billedChars.toLocaleString()} characters voiced`}
          </summary>
          <ul className="mt-2 grid gap-0.5 text-[12px] tabular-nums">
            {job.calls.map((call, index) => (
              <li key={index}>
                {call.stage.replace("_", " ")} on {call.model}:{" "}
                {(call.latencyMs / 1000).toFixed(1)} s,{" "}
                {(
                  call.inputTokens +
                  call.outputTokens +
                  call.thoughtTokens
                ).toLocaleString()}{" "}
                tokens
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="flex flex-wrap gap-7">
        {scores.map(([label, value, of]) => (
          <span key={label}>
            {label} <span className="text-cream tabular-nums">{value}</span> {of}
          </span>
        ))}
      </div>
    </div>
  );

  const adaptMode = view === "adapt";

  return (
    <div className="nua-page pb-10">
      <div className="px-(--gutter)">
        <Link
          href={demo ? "/" : "/localize"}
          aria-label={demo ? "Back to the main page" : "Back to my videos"}
          title="Back"
          className="flex size-11 items-center justify-center border border-cream/40 transition-colors hover:border-cream hover:bg-cream hover:text-ink nua-focus"
        >
          <ArrowLeft className="size-[18px]" strokeWidth={1.5} />
        </Link>
      </div>

      <header className="flex flex-col gap-[22px] px-(--gutter) pt-10">
        {demo ? (
          <h1 className="nua-display text-[max(40px,4.2vw)]">
            One lesson, carried into a new{" "}
            <em>
              <Scramble word="language" seed={7} />.
            </em>
          </h1>
        ) : (
          <h1 className="nua-display max-w-5xl text-[max(36px,3.6vw)] text-balance">
            {analysis?.topic ?? (
              <>
                Localizing your <em>video</em>
              </>
            )}
          </h1>
        )}
        {analysis === null ? null : (
          <p className="max-w-2xl text-[17px] leading-[1.45] text-pretty text-cream/62">
            {demo ? `${analysis.topic}. ` : ""}English to Hindi, for{" "}
            {analysis.audience.toLowerCase()}
          </p>
        )}
        {demo ? (
          <p className="max-w-3xl text-[15px] leading-normal text-stone">
            A real run of the pipeline, saved so it opens instantly. Play it and switch
            between English and Hindi: the Hindi runs on the same timeline. Then pick any
            segment below to see why the Hindi says what it says.
          </p>
        ) : null}
      </header>

      {job.status === "done" ? null : (
        <div className="mx-(--gutter) mt-12">
          <ProgressSteps
            status={job.status}
            failedAt={failedAt(job)}
            startedAt={job.createdAt}
          />
        </div>
      )}
      {job.status === "failed" ? (
        <div
          role="alert"
          className="mx-(--gutter) mt-6 border border-flag/60 bg-flag/10 p-4 text-[15px]"
        >
          <p className="font-medium">This job stopped before it finished.</p>
          <p className="mt-1 text-cream/75">
            {job.error ?? "No error message was recorded."} Everything the earlier steps
            produced is still shown below. Upload the clip again to retry.
          </p>
        </div>
      ) : null}
      {pollError === null ? null : (
        <p className="mx-(--gutter) mt-3 text-[13px] text-stone" role="status">
          Could not refresh ({pollError}); retrying.
        </p>
      )}

      <div className="mx-(--gutter) mt-14">
        <Player
          media={media}
          poster={!hasVideo && job.posterUri !== null && !demo ? posterUrl(job) : null}
          hasVideo={hasVideo}
          segments={segments}
          current={shown}
          playheadSec={playing?.sourceSec ?? null}
          durationSec={durationSec}
          nowSec={nowSec}
          isPlaying={isPlaying}
          hindiReady={hindiReady}
          language={language}
          onLanguage={switchLanguage}
          onToggle={toggle}
          onJump={jumpTo}
          footer={
            <>
              {critique === null ? (
                <span className="text-[15px] text-cream/62">
                  {hindiReady
                    ? ""
                    : `The Hindi ${hasVideo ? "video" : "audio"} appears here when it is ready.`}
                </span>
              ) : (
                <span className="text-[15px] text-cream/62">
                  Fidelity <span className="text-cream">{critique.overallFidelity}</span>{" "}
                  · Naturalness{" "}
                  <span className="text-cream">{critique.overallNaturalness}</span> ·{" "}
                  {segments.length} segments
                  {adaptation === null
                    ? ""
                    : ` · ${adaptation.brief.glossary.length} glossary terms`}
                </span>
              )}
              {hindiDownload === null ? null : (
                <a href={hindiDownload} download className="nua-btn ml-auto">
                  Download translated {job.outputVideoUri === null ? "audio" : "video"}
                </a>
              )}
            </>
          }
        />
      </div>

      {segments.length === 0 ? null : (
        <>
          <div className="mx-(--gutter) mt-[88px] mb-8 flex flex-wrap items-end justify-between gap-5">
            <h2 className="nua-display text-[max(36px,3.3vw)] tracking-[-0.035em]">
              {adaptMode ? "Five steps, one" : "The lesson, in two"}{" "}
              <em>
                <Scramble
                  key={view}
                  word={adaptMode ? "segment" : "layers"}
                  seed={3}
                  delayMs={100}
                />
              </em>
            </h2>
            <div role="group" aria-label="View" className="flex gap-2.5">
              <button
                type="button"
                aria-pressed={!adaptMode}
                onClick={() => setView("lesson")}
                className="nua-btn nua-btn-outline"
              >
                Lesson
              </button>
              <button
                type="button"
                aria-pressed={adaptMode}
                onClick={() => setView("adapt")}
                className="nua-btn nua-btn-outline"
              >
                How the AI adapted it
              </button>
            </div>
          </div>
          {adaptMode ? (
            <AdaptView
              segments={segments}
              selectedIndex={selectedIndex}
              onSelect={(index) => setSelectedId(segments[index]?.source.id ?? null)}
              brief={adaptation?.brief ?? null}
              speakers={analysis?.speakers ?? []}
              onPlay={playSegment}
              footer={hood}
            />
          ) : (
            <LessonLayers
              segments={segments}
              glossary={adaptation?.brief.glossary ?? []}
              playingId={playing?.id ?? null}
              onJump={jumpTo}
              onSeek={(sec) => {
                // Glossary times are source times; on the Hindi track, find the
                // segment that adapts that moment and start from its Hindi.
                if (language === "source") return seek(sec);
                const entry = [...segments]
                  .reverse()
                  .find((s) => s.source.startSec <= sec + 0.3);
                if (entry !== undefined) jumpTo(entry);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
