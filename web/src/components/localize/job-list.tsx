import Link from "next/link";
import { ChevronRight, Loader2 } from "lucide-react";
import type { JobStatus, JobSummary } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

const STATUS: Record<JobStatus, { label: string; className: string }> = {
  queued: { label: "Queued", className: "bg-muted text-muted-foreground" },
  ingesting: { label: "Preparing", className: "bg-primary/10 text-primary" },
  analyzing: { label: "Listening", className: "bg-primary/10 text-primary" },
  adapting: { label: "Re-teaching", className: "bg-primary/10 text-primary" },
  critiquing: { label: "Checking", className: "bg-primary/10 text-primary" },
  synthesizing: { label: "Voicing", className: "bg-primary/10 text-primary" },
  done: {
    label: "Ready",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  failed: { label: "Failed", className: "bg-destructive/10 text-destructive" },
};

const RUNNING: JobStatus[] = [
  "ingesting",
  "analyzing",
  "adapting",
  "critiquing",
  "synthesizing",
];

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "5 minutes ago", "yesterday": the question a history list answers is how recent. */
function ago(iso: string, now: number): string {
  const sec = (Date.parse(iso) - now) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(sec) >= size) return relative.format(Math.round(sec / size), unit);
  }
  return "just now";
}

/** Your jobs, newest first. A server component: it renders data it is handed. */
export function JobList({ jobs }: { jobs: JobSummary[] }) {
  if (jobs.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        Nothing here yet. Your localized clips will appear here, ready to replay and
        inspect.
      </p>
    );
  }

  // Rendered once on the server per request, so there is no hydration to disagree with.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  return (
    <ul className="divide-y rounded-lg border bg-card">
      {jobs.map((job) => {
        const status = STATUS[job.status];
        return (
          <li key={job.id}>
            <Link
              href={`/localize/${job.id}`}
              className="flex items-center justify-between gap-4 p-4 text-sm transition-colors hover:bg-muted/50"
            >
              <div className="grid min-w-0 gap-0.5">
                <span className="truncate font-medium">
                  {job.topic ?? "Working out the topic"}
                </span>
                <span className="text-xs text-muted-foreground">
                  <time
                    dateTime={job.createdAt}
                    title={new Date(job.createdAt).toUTCString()}
                  >
                    {ago(job.createdAt, now)}
                  </time>
                  {job.segmentCount === null ? "" : `, ${job.segmentCount} segments`}
                </span>
              </div>
              <span className="flex shrink-0 items-center gap-2">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                    status.className
                  )}
                >
                  {RUNNING.includes(job.status) ? (
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                  ) : null}
                  {status.label}
                </span>
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
