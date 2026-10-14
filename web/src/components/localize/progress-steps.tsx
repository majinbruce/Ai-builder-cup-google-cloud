"use client";

import { useEffect, useState } from "react";
import type { JobStatus } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";
import { PIPELINE_STEPS, stepIndex } from "@/components/localize/format";

/** Measured upload-to-done on the fixture (docs/SPEC.md section g): 216-238 s. */
const TYPICAL_SEC = 240;

const formatElapsed = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/**
 * The five stages as the design's numbered tab strip. A failed job shows how
 * far it got: the step it failed in is the first one that is neither done nor
 * running, and the artifacts from the steps before it are still rendered below
 * by the watch page.
 *
 * A running job also shows how long it has been going against how long one
 * usually takes, because four minutes with no clock feels like a hang.
 */
export function ProgressSteps({
  status,
  failedAt,
  startedAt,
}: {
  status: JobStatus;
  /** For a failed job, the last status it reached before failing. */
  failedAt?: JobStatus;
  /** ISO time the job was created, for the elapsed clock. */
  startedAt?: string;
}) {
  const current =
    status === "failed" ? stepIndex(failedAt ?? "queued") : stepIndex(status);
  const active = status !== "done" && status !== "failed";

  // Null until the first tick, so the server's HTML and the first client
  // render agree; the clock appears a second after hydration.
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (!active || startedAt === undefined) return;
    const start = Date.parse(startedAt);
    const timer = setInterval(() => setElapsed((Date.now() - start) / 1000), 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);

  return (
    <section className="grid gap-5" aria-label="Pipeline progress">
      {active ? (
        <p className="text-[15px] text-cream/62" role="status">
          {elapsed === null
            ? "Working."
            : `Running for ${formatElapsed(elapsed)}; a one-minute clip usually takes about ${Math.round(TYPICAL_SEC / 60)} minutes.`}{" "}
          Results appear below as each step finishes, and the job keeps running if you
          leave this page.
        </p>
      ) : null}
      <ol className="grid gap-6 sm:grid-cols-5">
        {PIPELINE_STEPS.slice(1).map((step, offset) => {
          const index = offset + 1;
          const done = status === "done" || index < current;
          const running = active && index === current;
          const failed = status === "failed" && index === current;

          return (
            <li
              key={step.status}
              aria-current={running ? "step" : undefined}
              className={cn(
                "grid content-start gap-2 border-b pb-3",
                done && "border-olive",
                running && "border-cream",
                failed && "border-flag",
                !done && !running && !failed && "border-cream/14"
              )}
            >
              <span
                className={cn(
                  "nua-caps flex items-center gap-2 text-[14px]",
                  running || done ? "text-cream" : "text-cream/40",
                  failed && "text-flag"
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-[9px]",
                    done && "bg-olive",
                    running && "animate-pulse bg-cream",
                    failed && "bg-flag",
                    !done && !running && !failed && "border border-cream/30"
                  )}
                />
                0{offset + 1} {step.label}
                <span className="sr-only">
                  {done ? "done" : running ? "running" : failed ? "failed" : "waiting"}
                </span>
              </span>
              <p className="text-[13px] leading-snug text-stone">{step.detail}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
