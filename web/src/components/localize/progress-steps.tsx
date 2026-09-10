import { Check, Loader2 } from "lucide-react";
import type { JobStatus } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";
import { PIPELINE_STEPS, stepIndex } from "@/components/localize/format";

/**
 * The five stages as a checklist. A failed job shows how far it got: the step
 * it failed in is the first one that is neither done nor running, and the
 * artifacts from the steps before it are still rendered below by the job view.
 */
export function ProgressSteps({
  status,
  failedAt,
}: {
  status: JobStatus;
  /** For a failed job, the last status it reached before failing. */
  failedAt?: JobStatus;
}) {
  const current =
    status === "failed" ? stepIndex(failedAt ?? "queued") : stepIndex(status);

  return (
    <ol className="grid gap-3 sm:grid-cols-5" aria-label="Pipeline progress">
      {PIPELINE_STEPS.slice(1).map((step, offset) => {
        const index = offset + 1;
        const done = status === "done" || index < current;
        const running = status !== "done" && status !== "failed" && index === current;
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
                <Loader2 className="size-4 animate-spin" aria-hidden />
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
  );
}
