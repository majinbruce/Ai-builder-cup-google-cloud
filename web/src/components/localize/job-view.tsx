"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RotateCcw, Volume2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { audioUrl, getJob, videoUrl } from "@/lib/api/localize";
import type { Job, JobStatus, ModelCall } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";
import { LessonMap } from "@/components/localize/lesson-map";
import { ProgressSteps } from "@/components/localize/progress-steps";
import {
  ReasoningPanel,
  type OutputWindow,
  type SegmentBundle,
} from "@/components/localize/reasoning-panel";
import { SIGNAL_LABEL, SIGNAL_TONE, formatTime } from "@/components/localize/format";

const POLL_MS = 2_000;
const TERMINAL: JobStatus[] = ["done", "failed"];

/** Whole-clip calls, shown in every segment's footer as shared cost. */
const SHARED_STAGES: ModelCall["stage"][] = ["analyze", "brief", "critique"];

const DECISION_LABEL = {
  transliterate: "Written in Devanagari",
  translate: "Translated",
  keep_english_concept: "Kept as the English concept",
} as const;

/**
 * For a failed job, the stage it failed in — inferred from which artifacts
 * made it onto the row, since each stage writes its own the moment it ends.
 */
function failedAt(job: Job): JobStatus {
  if (job.analysis === null) return "analyzing";
  if (job.adaptation === null) return "adapting";
  if (job.synthesis === null && job.critique === null) return "critiquing";
  return "synthesizing";
}

/**
 * Joins the four stage artifacts into one record per segment, by id.
 *
 * Per-segment call attribution follows the order the API writes `calls`:
 * analyze, brief, one adapt per segment in segment order, critique, then one
 * adapt_retry per retried segment in `retriedIds` order.
 */
function bundle(job: Job): SegmentBundle[] {
  const { analysis, adaptation, critique, synthesis, corroboration } = job;
  if (analysis === null) return [];

  const adaptCalls = job.calls.filter((call) => call.stage === "adapt");
  const retryCalls = job.calls.filter((call) => call.stage === "adapt_retry");
  const sharedCalls = job.calls.filter((call) => SHARED_STAGES.includes(call.stage));
  const retried = job.retriedIds ?? [];

  const sourceById = new Map(analysis.segments.map((segment) => [segment.id, segment]));
  const windows = new Map<string, OutputWindow>();
  const utterances = synthesis?.utterances;

  if (utterances !== undefined) {
    // Each utterance sits at a measured place on the output timeline; every
    // segment in it plays the whole utterance.
    for (const utterance of utterances) {
      const first = sourceById.get(utterance.segmentIds[0] ?? "");
      const last = sourceById.get(utterance.segmentIds.at(-1) ?? "");
      if (first === undefined || last === undefined) continue;
      for (const id of utterance.segmentIds) {
        windows.set(id, {
          startSec: utterance.outputStartSec,
          lengthSec: utterance.measuredDurationSec,
          sourceStartSec: first.startSec,
          sourceEndSec: last.endSec,
        });
      }
    }
  } else {
    // Jobs from before 2026-10-01: one call per segment, butt-joined.
    let offset = 0;
    for (const segment of synthesis?.segments ?? []) {
      const length = segment.measuredDurationSec ?? 0;
      windows.set(segment.id, {
        startSec: offset,
        lengthSec: length,
        sourceStartSec: segment.startSec,
        sourceEndSec: segment.endSec,
      });
      offset += length;
    }
  }

  return analysis.segments.map((source, index) => {
    const synth = synthesis?.segments.find((segment) => segment.id === source.id);
    const retryIndex = retried.indexOf(source.id);
    const ownCalls = [
      adaptCalls[index],
      retryIndex === -1 ? undefined : retryCalls[retryIndex],
    ].filter((call): call is ModelCall => call !== undefined);

    return {
      source,
      adapted: adaptation?.segments.find((segment) => segment.id === source.id),
      critique: critique?.segments.find((segment) => segment.id === source.id),
      synth,
      utterance:
        synth?.utterance === undefined ? undefined : utterances?.[synth.utterance],
      output: windows.get(source.id),
      checks: (corroboration?.emphasisChecks ?? []).filter(
        (check) => check.segmentId === source.id
      ),
      retried: retryIndex !== -1,
      ownCalls,
      sharedCalls,
    };
  });
}

/**
 * Where a playhead on either track falls, as a segment and a position in
 * SOURCE time. The Hindi for a stretch of source runs longer or shorter than
 * it, so its position is mapped proportionally into the source stretch it
 * adapts — which is what lets one lesson map carry a playhead for both.
 */
function locate(
  segments: SegmentBundle[],
  track: "source" | "output",
  sec: number
): { id: string; sourceSec: number } | null {
  for (const entry of segments) {
    const { startSec, endSec } = entry.source;
    if (track === "source") {
      if (sec >= startSec && sec < endSec) return { id: entry.source.id, sourceSec: sec };
      continue;
    }
    const span = entry.output;
    if (span === undefined || span.lengthSec <= 0) continue;
    if (sec >= span.startSec && sec < span.startSec + span.lengthSec) {
      const fraction = (sec - span.startSec) / span.lengthSec;
      const sourceSec =
        span.sourceStartSec + fraction * (span.sourceEndSec - span.sourceStartSec);
      // A window can span several segments; the playhead belongs to the one
      // whose source time it maps into.
      const owner = segments.find(
        (other) => sourceSec >= other.source.startSec && sourceSec < other.source.endSec
      );
      return { id: (owner ?? entry).source.id, sourceSec };
    }
  }
  return null;
}

/**
 * The job page, from upload to reasoning panel.
 *
 * Polls while the job runs and renders whatever exists at each poll, because
 * the API writes every stage's output as it finishes: the segment list appears
 * with the analysis, fills with Hindi during adapt, gains scores after the
 * critique, and gets its play buttons when the audio lands.
 */
export function JobView({
  initialJob,
  demo = false,
}: {
  initialJob: Job;
  demo?: boolean;
}) {
  const [job, setJob] = useState(initialJob);
  const [pollError, setPollError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [playing, setPlaying] = useState<{ id: string; sourceSec: number } | null>(null);

  // Media elements, not audio elements: a job made from an mp4 plays <video>,
  // and everything below (seek, stop-at, playhead) is the same API on both.
  const sourceAudio = useRef<HTMLMediaElement>(null);
  const outputAudio = useRef<HTMLMediaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
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
  const selected = segments[selectedIndex];

  /** Brings a segment's row into view without yanking the page when it is already visible. */
  const reveal = (id: string) => {
    document
      .getElementById(`segment-${id}`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  /**
   * Selects a segment from the list or the map. On a narrow screen the panel
   * sits below the whole list, so a tap there would change something
   * off-screen; scroll to it instead.
   */
  const choose = (id: string) => {
    setSelectedId(id);
    if (window.matchMedia("(max-width: 1023px)").matches) {
      panelRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  };

  const step = (delta: number) => {
    const next = segments[selectedIndex + delta];
    if (next === undefined) return;
    setSelectedId(next.source.id);
    reveal(next.source.id);
    return next.source.id;
  };

  /**
   * Plays one segment of one track: seek, play, and pause at the segment's end.
   * Seeking works because the API answers HTTP Range requests on both tracks.
   */
  const playSegment = (entry: SegmentBundle, which: "source" | "output") => {
    const element = which === "source" ? sourceAudio.current : outputAudio.current;
    const other = which === "source" ? outputAudio.current : sourceAudio.current;
    if (element === null) return;

    const start = which === "source" ? entry.source.startSec : entry.output?.startSec;
    const length =
      which === "source" ? entry.source.endSec - entry.source.startSec : entry.output?.lengthSec;
    if (start === undefined || length === undefined) return;

    other?.pause();
    element.currentTime = start;
    stopAt.current = { element, startSec: start, endSec: start + length };
    void element.play();
  };

  /**
   * Two jobs on every tick. First, stop a segment play at the segment's end —
   * but only while the playhead is still inside that segment. Without the range
   * check, a stop point outlives the play it was set for: pause mid-segment,
   * scrub past it with the native controls, press play, and the track stops
   * dead on the next tick. Second, move the lesson map's playhead and, when
   * following, the selection.
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

    if (element.paused) return;
    const at = locate(segments, track, now);
    setPlaying(at);
    // Selection only: scrolling here would drag a listener at the players
    // down to the list the moment the audio crossed a segment boundary.
    if (follow && at !== null && at.id !== selected?.source.id) setSelectedId(at.id);
  };

  /** A pause the user chose ends the segment play; resuming plays on freely. */
  const onPause = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    if (stopAt.current?.element === event.currentTarget) stopAt.current = null;
  };

  /** Only one track at a time: the two are different languages over the same idea. */
  const onPlay = (track: "source" | "output") => {
    (track === "source" ? outputAudio.current : sourceAudio.current)?.pause();
  };

  const onListKeyDown = (event: React.KeyboardEvent<HTMLOListElement>) => {
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const id = step(delta);
    if (id !== undefined) {
      document.getElementById(`segment-${id}`)?.querySelector("button")?.focus();
    }
  };

  const { analysis, adaptation, critique, synthesis, corroboration } = job;
  const totals = job.calls.reduce(
    (sum, call) => ({
      input: sum.input + call.inputTokens,
      output: sum.output + call.outputTokens,
      thought: sum.thought + call.thoughtTokens,
      latencyMs: sum.latencyMs + call.latencyMs,
    }),
    { input: 0, output: 0, thought: 0, latencyMs: 0 }
  );
  const retriedCount = job.retriedIds?.length ?? 0;

  return (
    <div className="grid gap-8">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          {analysis?.topic ?? "Localizing your clip"}
        </h1>
        <p className="text-sm text-muted-foreground">
          English to Hindi
          {analysis === null ? "" : `, for ${analysis.audience.toLowerCase()}`}
          {segments.length === 0 ? "" : `. ${segments.length} segments`}
          {synthesis === null
            ? ""
            : `, ${Math.round(synthesis.durationSec)} seconds of Hindi audio`}
          .
        </p>
      </header>

      {demo ? <DemoGuide /> : null}

      {job.status === "done" ? null : (
        <ProgressSteps
          status={job.status}
          failedAt={failedAt(job)}
          startedAt={job.createdAt}
        />
      )}

      {job.status === "failed" ? (
        <Alert variant="destructive">
          <AlertTitle>This job stopped before it finished</AlertTitle>
          <AlertDescription>
            {job.error ?? "No error message was recorded."} Everything the earlier steps
            produced is still shown below. Upload the clip again to retry.
          </AlertDescription>
        </Alert>
      ) : null}

      {pollError === null ? null : (
        <p className="text-xs text-muted-foreground" role="status">
          Could not refresh ({pollError}); retrying.
        </p>
      )}

      {analysis === null ? null : (
        <Card>
          <CardContent className="grid gap-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <Track label="Original, English">
                {job.sourceVideoUri === null ? (
                  <audio
                    ref={sourceAudio as React.RefObject<HTMLAudioElement | null>}
                    controls
                    preload="metadata"
                    src={audioUrl(job, "source", { demo })}
                    onTimeUpdate={(event) => onTimeUpdate(event, "source")}
                    onPause={onPause}
                    onPlay={() => onPlay("source")}
                    className="w-full"
                  />
                ) : (
                  <video
                    ref={sourceAudio as React.RefObject<HTMLVideoElement | null>}
                    controls
                    playsInline
                    preload="metadata"
                    src={videoUrl(job, "source", { demo })}
                    onTimeUpdate={(event) => onTimeUpdate(event, "source")}
                    onPause={onPause}
                    onPlay={() => onPlay("source")}
                    className="aspect-video w-full rounded-md bg-black"
                  />
                )}
              </Track>
              <Track label="Localized, Hindi">
                {synthesis === null ? (
                  <p
                    className={cn(
                      "flex items-center text-sm text-muted-foreground",
                      job.sourceVideoUri === null
                        ? "h-[54px]"
                        : "aspect-video justify-center rounded-md border border-dashed px-4 text-center"
                    )}
                  >
                    The Hindi voice is recorded last
                    {job.sourceVideoUri === null ? "." : ", then laid under the video."}
                  </p>
                ) : job.outputVideoUri === null ? (
                  <audio
                    ref={outputAudio as React.RefObject<HTMLAudioElement | null>}
                    controls
                    preload="metadata"
                    src={audioUrl(job, "output", { demo })}
                    onTimeUpdate={(event) => onTimeUpdate(event, "output")}
                    onPause={onPause}
                    onPlay={() => onPlay("output")}
                    className="w-full"
                  />
                ) : (
                  <video
                    ref={outputAudio as React.RefObject<HTMLVideoElement | null>}
                    controls
                    playsInline
                    preload="metadata"
                    src={videoUrl(job, "output", { demo })}
                    onTimeUpdate={(event) => onTimeUpdate(event, "output")}
                    onPause={onPause}
                    onPlay={() => onPlay("output")}
                    className="aspect-video w-full rounded-md bg-black"
                  />
                )}
              </Track>
            </div>

            <div className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium">
                  What the teacher is doing, moment by moment
                </h2>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={follow}
                    onChange={(event) => setFollow(event.target.checked)}
                    className="size-3.5 accent-primary"
                  />
                  Follow the audio
                </label>
              </div>
              <LessonMap
                segments={segments.map((entry) => entry.source)}
                selectedId={selected?.source.id}
                onSelect={(id) => choose(id)}
                playheadSec={playing?.sourceSec ?? null}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {critique === null ? null : (
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Fidelity"
            value={critique.overallFidelity}
            outOf={100}
            hint="Does the Hindi still teach the same thing? Scored by a critic that never saw the reasoning."
          />
          <Stat
            label="Naturalness"
            value={critique.overallNaturalness}
            outOf={100}
            hint="Does it sound like a teacher speaking, rather than a translation?"
          />
          {corroboration === null ? null : (
            <Stat
              label="Stress confirmed in the audio"
              value={corroboration.supportedByEnergy}
              outOf={corroboration.emphasisChecks.length}
              hint="Words the model heard stressed that ffmpeg's loudness measurements back up."
            />
          )}
          <Stat
            label="Rewritten after critique"
            value={retriedCount}
            outOf={segments.length}
            hint="Segments that scored under 70 and were adapted again, once."
          />
        </dl>
      )}

      {segments.length === 0 || selected === undefined ? null : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <section
            className="grid content-start gap-3"
            aria-labelledby="segments-heading"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h2 id="segments-heading" className="text-lg font-semibold tracking-tight">
                Segments
              </h2>
              <span className="hidden text-xs text-muted-foreground sm:inline">
                Use ↑ and ↓ to move between them
              </span>
            </div>
            <ol className="grid gap-2" onKeyDown={onListKeyDown}>
              {segments.map((entry, index) => {
                const active = entry.source.id === selected.source.id;
                const heard = entry.source.id === playing?.id;
                return (
                  <li key={entry.source.id} id={`segment-${entry.source.id}`}>
                    <button
                      type="button"
                      onClick={() => choose(entry.source.id)}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "grid w-full gap-2 rounded-lg border bg-card p-3 text-left text-sm transition-colors hover:border-primary/40",
                        active && "border-primary bg-primary/5 hover:border-primary"
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="tabular-nums text-muted-foreground">
                          {index + 1}. {formatTime(entry.source.startSec)}
                        </span>
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 font-medium",
                            SIGNAL_TONE[entry.source.signal]
                          )}
                        >
                          {SIGNAL_LABEL[entry.source.signal]}
                        </span>
                        {heard ? (
                          <span className="inline-flex items-center gap-1 text-primary">
                            <Volume2 className="size-3.5" aria-hidden />
                            playing
                          </span>
                        ) : null}
                        {entry.retried ? (
                          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                            <RotateCcw className="size-3" aria-hidden /> rewritten
                          </span>
                        ) : null}
                        {entry.critique === undefined ? null : (
                          <span
                            className="ml-auto tabular-nums text-muted-foreground"
                            title="Fidelity and naturalness, out of 100"
                          >
                            {entry.critique.fidelity} / {entry.critique.naturalness}
                          </span>
                        )}
                      </div>
                      <p className="text-muted-foreground">{entry.source.text}</p>
                      {entry.adapted === undefined ? null : (
                        <p lang="hi" className="text-base">
                          {entry.adapted.targetText}
                        </p>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>

          <div ref={panelRef} className="scroll-mt-20">
            <Card className="gap-0 py-0 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto">
              <CardHeader className="sticky top-0 z-10 flex flex-row items-center justify-between gap-2 border-b bg-card py-3">
                <CardTitle className="text-base">
                  Why segment {selectedIndex + 1} reads this way
                </CardTitle>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={selectedIndex === 0}
                    onClick={() => step(-1)}
                    aria-label="Previous segment"
                  >
                    <ChevronLeft />
                  </Button>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {selectedIndex + 1} of {segments.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={selectedIndex === segments.length - 1}
                    onClick={() => step(1)}
                    aria-label="Next segment"
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="py-5">
                <ReasoningPanel
                  key={selected.source.id}
                  bundle={selected}
                  glossary={adaptation?.brief.glossary ?? []}
                  onPlay={(which) => playSegment(selected, which)}
                />
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {adaptation === null ? null : (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              The plan, written before any translation
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              One brief for the whole clip, so every segment speaks as the same teacher
              and uses the same words for the same ideas.
            </p>
          </CardHeader>
          <CardContent className="grid gap-5 text-sm">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid content-start gap-1">
                <h3 className="font-medium">The teacher</h3>
                <p className="text-muted-foreground">
                  {adaptation.brief.instructorPersona}
                </p>
              </div>
              <div className="grid content-start gap-1">
                <h3 className="font-medium">How the Hindi should sound</h3>
                <p className="text-muted-foreground">
                  {adaptation.brief.registerGuidance}
                </p>
              </div>
            </div>
            {adaptation.brief.glossary.length > 0 ? (
              <div className="grid gap-2">
                <h3 className="font-medium">
                  Glossary, fixed for the whole clip ({adaptation.brief.glossary.length}{" "}
                  terms)
                </h3>
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-muted/50 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">English</th>
                        <th className="px-3 py-2 font-medium">Hindi</th>
                        <th className="px-3 py-2 font-medium">Decision</th>
                        <th className="px-3 py-2 font-medium">Why</th>
                      </tr>
                    </thead>
                    <tbody>
                      {adaptation.brief.glossary.map((entry) => (
                        <tr key={entry.english} className="border-t align-top">
                          <td className="px-3 py-2 font-medium">{entry.english}</td>
                          <td className="px-3 py-2 whitespace-nowrap" lang="hi">
                            {entry.targetForm}
                          </td>
                          <td className="px-3 py-2 text-xs whitespace-nowrap">
                            {DECISION_LABEL[entry.decision]}
                          </td>
                          <td className="min-w-64 px-3 py-2 text-xs text-muted-foreground">
                            {entry.why}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      {job.calls.length === 0 ? null : (
        <details className="group rounded-lg border px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Under the hood: {job.calls.length} Gemini calls,{" "}
            {(totals.latencyMs / 1000).toFixed(0)} s of model time
          </summary>
          <div className="mt-3 grid gap-1 text-xs tabular-nums text-muted-foreground">
            <p>
              {totals.input.toLocaleString()} input, {totals.output.toLocaleString()}{" "}
              output and {totals.thought.toLocaleString()} thinking tokens
              {synthesis === null
                ? "."
                : `; ${synthesis.billedChars.toLocaleString()} characters sent to Cloud Text-to-Speech.`}
            </p>
            <ul className="mt-2 grid gap-0.5">
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
          </div>
        </details>
      )}
    </div>
  );
}

function Track({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </div>
  );
}

/**
 * The demo is a judge's first contact with the product and nobody is there to
 * narrate it, so the page says what to do with it, in the order that shows the
 * idea fastest.
 */
function DemoGuide() {
  const steps = [
    "Play either track. The coloured map above the segments follows along, showing where the teacher defines, gives an example or changes tone.",
    "Pick any segment to see why the Hindi says what it says, next to what a literal translation would have said.",
    "Check the work: a separate critic read the Hindi back into English without seeing the reasoning, and ffmpeg measured whether the stressed words really were stressed.",
  ];
  return (
    <section
      aria-label="How to read this page"
      className="grid gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 sm:p-5"
    >
      <p className="text-sm">
        <span className="font-semibold">This is a real run of the pipeline</span>, saved
        so it opens instantly. Three things to try:
      </p>
      <ol className="grid gap-3 text-sm text-muted-foreground md:grid-cols-3">
        {steps.map((text, index) => (
          <li key={index} className="flex gap-2.5">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              {index + 1}
            </span>
            {text}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Stat({
  label,
  value,
  outOf,
  hint,
}: {
  label: string;
  value: number;
  outOf: number;
  hint: string;
}) {
  return (
    <div className="grid content-start gap-1 rounded-lg border bg-card p-4">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="text-3xl font-semibold tabular-nums">
        {value}
        <span className="text-base font-normal text-muted-foreground"> / {outOf}</span>
      </dd>
      <dd className="text-xs text-muted-foreground">{hint}</dd>
    </div>
  );
}
