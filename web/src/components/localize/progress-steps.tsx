"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { JobStatus } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";
import { PIPELINE_STEPS, stepIndex } from "@/components/localize/format";

/** Measured upload-to-done on the fixture (docs/SPEC.md section g): 216-238 s. */
const TYPICAL_SEC = 240;

const formatElapsed = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/**
 * The five stages as a checklist. A failed job shows how far it got: the step
 * it failed in is the first one that is neither done nor running, and the
 * artifacts from the steps before it are still rendered below by the job view.
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
    <section className="grid gap-3" aria-label="Pipeline progress">
      {active ? (
        <p className="text-sm text-muted-foreground" role="status">
          {elapsed === null
            ? "Working."
            : `Running for ${formatElapsed(elapsed)}; a one-minute clip usually takes about ${Math.round(TYPICAL_SEC / 60)} minutes.`}{" "}
          Results appear below as each step finishes, and the job keeps running if you
          leave this page.
        </p>
      ) : null}
      <ol className="grid gap-3 sm:grid-cols-5">
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
                "rounded-lg border p-3 text-sm",
                done && "border-emerald-500/40 bg-emerald-500/5",
                running && "border-primary bg-primary/5",
                failed && "border-destructive bg-destructive/5"
              )}
            >
              <div className="flex items-center gap-2 font-medium">
                {done ? (
                  <Check className="size-4 text-emerald-600" aria-hidden />
                ) : running ? (
                  <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
                ) : (
                  <span
                    className={cn(
                      "size-4 rounded-full border",
                      failed && "border-destructive bg-destructive"
                    )}
                    aria-hidden
                  />
                )}
                {step.label}
                <span className="sr-only">
                  {done ? "done" : running ? "running" : failed ? "failed" : "waiting"}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{step.detail}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
