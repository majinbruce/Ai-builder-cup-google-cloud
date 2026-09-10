"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { audioUrl, getJob } from "@/lib/api/localize";
import type { Job, JobStatus, ModelCall } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";
import { ProgressSteps } from "@/components/localize/progress-steps";
import {
  ReasoningPanel,
  type SegmentBundle,
} from "@/components/localize/reasoning-panel";
import { SIGNAL_LABEL, SIGNAL_TONE, formatTime } from "@/components/localize/format";

const POLL_MS = 2_000;
const TERMINAL: JobStatus[] = ["done", "failed"];

/** Whole-clip calls, shown in every segment's footer as shared cost. */
const SHARED_STAGES: ModelCall["stage"][] = ["analyze", "brief", "critique"];

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

  let offset = 0;
  const offsets = new Map<string, number>();
  for (const segment of synthesis?.segments ?? []) {
    offsets.set(segment.id, offset);
    offset += segment.measuredDurationSec;
  }

  return analysis.segments.map((source, index) => {
    const retryIndex = retried.indexOf(source.id);
    const ownCalls = [
      adaptCalls[index],
      retryIndex === -1 ? undefined : retryCalls[retryIndex],
    ].filter((call): call is ModelCall => call !== undefined);

    return {
      source,
      adapted: adaptation?.segments.find((segment) => segment.id === source.id),
      critique: critique?.segments.find((segment) => segment.id === source.id),
      synth: synthesis?.segments.find((segment) => segment.id === source.id),
      outputOffsetSec: offsets.get(source.id),
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

  const sourceAudio = useRef<HTMLAudioElement>(null);
  const outputAudio = useRef<HTMLAudioElement>(null);
  const stopAt = useRef<{ element: HTMLAudioElement; sec: number } | null>(null);

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
  const selected =
    segments.find((entry) => entry.source.id === selectedId) ?? segments[0];

  /**
   * Plays one segment of one track: seek, play, and pause at the segment's end.
   * Seeking works because the API answers HTTP Range requests on both tracks.
   */
  const playSegment = (entry: SegmentBundle, which: "source" | "output") => {
    const element = which === "source" ? sourceAudio.current : outputAudio.current;
    const other = which === "source" ? outputAudio.current : sourceAudio.current;
    if (element === null) return;

    const start = which === "source" ? entry.source.startSec : entry.outputOffsetSec;
    const length =
      which === "source"
        ? entry.source.endSec - entry.source.startSec
        : entry.synth?.measuredDurationSec;
    if (start === undefined || length === undefined) return;

    other?.pause();
    element.currentTime = start;
    stopAt.current = { element, sec: start + length };
    void element.play();
  };

  const onTimeUpdate = (event: React.SyntheticEvent<HTMLAudioElement>) => {
    const target = stopAt.current;
    if (target !== null && event.currentTarget === target.element) {
      if (event.currentTarget.currentTime >= target.sec) {
        event.currentTarget.pause();
        stopAt.current = null;
      }
    }
  };

  const { analysis, adaptation, critique, synthesis, corroboration } = job;
  const totals = job.calls.reduce(
    (sum, call) => ({
      input: sum.input + call.inputTokens,
      output: sum.output + call.outputTokens,
      thought: sum.thought + call.thoughtTokens,
    }),
    { input: 0, output: 0, thought: 0 }
  );

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {analysis?.topic ?? "Localizing your clip…"}
        </h1>
        <p className="text-sm text-muted-foreground">
          English → Hindi
          {analysis === null ? "" : ` · for ${analysis.audience}`}
          {demo ? " · pre-computed demo job, a real run of this pipeline" : ""}
        </p>
      </header>

      {job.status === "done" ? null : (
        <ProgressSteps status={job.status} failedAt={failedAt(job)} />
      )}

      {job.status === "failed" ? (
        <Alert variant="destructive">
          <AlertTitle>This job failed</AlertTitle>
          <AlertDescription>
            {job.error ?? "No error message was recorded."}
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
          <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
            <div className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                Original (English)
              </span>
              <audio
                ref={sourceAudio}
                controls
                preload="metadata"
                src={audioUrl(job, "source", { demo })}
                onTimeUpdate={onTimeUpdate}
                className="w-full"
              />
            </div>
            <div className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                Localized (Hindi)
              </span>
              {synthesis === null ? (
                <p className="flex h-[54px] items-center text-sm text-muted-foreground">
                  Audio is synthesized last.
                </p>
              ) : (
                <audio
                  ref={outputAudio}
                  controls
                  preload="metadata"
                  src={audioUrl(job, "output", { demo })}
                  onTimeUpdate={onTimeUpdate}
                  className="w-full"
                />
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {critique === null ? null : (
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat
            label="Fidelity"
            value={`${critique.overallFidelity}`}
            hint="blind back-translation"
          />
          <Stat
            label="Naturalness"
            value={`${critique.overallNaturalness}`}
            hint="would a teacher say it"
          />
          <Stat
            label="Emphasis backed by energy"
            value={
              corroboration === null
                ? "—"
                : `${corroboration.supportedByEnergy}/${corroboration.emphasisChecks.length}`
            }
            hint="model claims vs ffmpeg"
          />
          <Stat
            label="Regenerated"
            value={`${job.retriedIds?.length ?? 0}`}
            hint="failed the critique gate once"
          />
        </dl>
      )}

      {segments.length === 0 || selected === undefined ? null : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <ol className="grid content-start gap-2" aria-label="Segments">
            {segments.map((entry) => {
              const active = entry.source.id === selected.source.id;
              return (
                <li key={entry.source.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(entry.source.id)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "grid w-full gap-2 rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted/50",
                      active && "border-primary bg-primary/5"
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="tabular-nums text-muted-foreground">
                        {formatTime(entry.source.startSec)}
                      </span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 font-medium",
                          SIGNAL_TONE[entry.source.signal]
                        )}
                      >
                        {SIGNAL_LABEL[entry.source.signal]}
                      </span>
                      {entry.retried ? (
                        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                          <RotateCcw className="size-3" aria-hidden /> regenerated
                        </span>
                      ) : null}
                      {entry.critique === undefined ? null : (
                        <span className="ml-auto tabular-nums text-muted-foreground">
                          F {entry.critique.fidelity} · N {entry.critique.naturalness}
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

          <Card className="h-fit lg:sticky lg:top-20">
            <CardHeader>
              <CardTitle className="text-base">
                Reasoning · {selected.source.id}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ReasoningPanel
                key={selected.source.id}
                bundle={selected}
                glossary={adaptation?.brief.glossary ?? []}
                onPlay={(which) => playSegment(selected, which)}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {adaptation === null ? null : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              The brief, written before any segment
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p>
              <span className="font-medium">Instructor: </span>
              {adaptation.brief.instructorPersona}
            </p>
            <p>
              <span className="font-medium">Register: </span>
              {adaptation.brief.registerGuidance}
            </p>
            {adaptation.brief.glossary.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Term</th>
                      <th className="py-1 pr-3 font-medium">Hindi</th>
                      <th className="py-1 pr-3 font-medium">Decision</th>
                      <th className="py-1 font-medium">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adaptation.brief.glossary.map((entry) => (
                      <tr key={entry.english} className="border-t align-top">
                        <td className="py-1.5 pr-3">{entry.english}</td>
                        <td className="py-1.5 pr-3" lang="hi">
                          {entry.targetForm}
                        </td>
                        <td className="py-1.5 pr-3">
                          {entry.decision.replaceAll("_", " ")}
                        </td>
                        <td className="py-1.5 text-muted-foreground">{entry.why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      {job.calls.length === 0 ? null : (
        <p className="text-xs tabular-nums text-muted-foreground">
          {job.calls.length} Gemini calls · {totals.input.toLocaleString()} in /{" "}
          {totals.output.toLocaleString()} out / {totals.thought.toLocaleString()}{" "}
          thinking tokens
          {synthesis === null
            ? ""
            : ` · ${synthesis.billedChars.toLocaleString()} TTS characters`}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
      <dd className="text-xs text-muted-foreground">{hint}</dd>
    </div>
  );
}
