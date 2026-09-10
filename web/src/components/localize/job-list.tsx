import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { JobSummary } from "@/lib/api/schemas";

/** Your jobs, newest first. A server component: it renders data it is handed. */
export function JobList({ jobs }: { jobs: JobSummary[] }) {
  if (jobs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No jobs yet. Upload a clip above.</p>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {jobs.map((job) => (
        <li key={job.id}>
          <Link
            href={`/localize/${job.id}`}
            className="flex items-center justify-between gap-4 p-3 text-sm hover:bg-muted/50"
          >
            <div className="grid min-w-0 gap-0.5">
              <span className="truncate font-medium">{job.topic ?? "Untitled clip"}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(job.createdAt).toLocaleString()}
                {job.segmentCount === null ? "" : ` · ${job.segmentCount} segments`}
              </span>
            </div>
            <Badge
              variant={
                job.status === "failed"
                  ? "destructive"
                  : job.status === "done"
                    ? "default"
                    : "secondary"
              }
            >
              {job.status}
            </Badge>
          </Link>
        </li>
      ))}
    </ul>
  );
}
