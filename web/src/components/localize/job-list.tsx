"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AudioLines, Loader2, MoreVertical, Trash2, Video } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ApiError } from "@/lib/api/envelope";
import { deleteJob, posterUrl } from "@/lib/api/localize";
import type { JobStatus, JobSummary } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";
import { formatTime } from "@/components/localize/format";

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

const SETTLED: JobStatus[] = ["done", "failed"];

/** How often the library re-reads itself while something is still processing. */
const REFRESH_MS = 5_000;

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "5 minutes ago", "yesterday": the question a library answers is how recent. */
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

/**
 * Your videos as a grid of cards: a frame of the footage (or an audio mark),
 * the topic once Gemini has named it, the length and the status.
 *
 * The list arrives from the server component; while any card is still being
 * processed this re-runs that component every few seconds, so a card turns
 * from "Listening" to "Ready" without a reload.
 */
export function JobList({ jobs }: { jobs: JobSummary[] }) {
  const router = useRouter();
  const [pendingDelete, setPendingDelete] = useState<JobSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const anyRunning = jobs.some((job) => !SETTLED.includes(job.status));
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [anyRunning, router]);

  const confirmDelete = async () => {
    if (pendingDelete === null) return;
    setDeleting(true);
    try {
      await deleteJob(pendingDelete.id);
      toast.success("Video deleted");
      setPendingDelete(null);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not delete the video"
      );
    } finally {
      setDeleting(false);
    }
  };

  // Rendered on the server and again on the client a moment later; the
  // relative time may differ by a minute between the two, which is fine.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  return (
    <>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {jobs.map((job) => {
          const status = STATUS[job.status];
          const settled = SETTLED.includes(job.status);
          return (
            <li
              key={job.id}
              className="group relative overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/40"
            >
              <Link href={`/localize/${job.id}`} className="grid">
                <div className="relative flex aspect-video items-center justify-center bg-muted">
                  {job.hasPoster ? (
                    // A plain <img>: the poster comes from our own API behind the
                    // session cookie, which next/image's optimizer would not send.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={posterUrl(job)}
                      alt=""
                      loading="lazy"
                      className="size-full object-cover"
                    />
                  ) : (
                    <AudioLines className="size-10 text-muted-foreground" aria-hidden />
                  )}
                  {job.durationSec === null ? null : (
                    <span className="absolute right-2 bottom-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium tabular-nums text-white">
                      {formatTime(job.durationSec)}
                    </span>
                  )}
                  {/* A solid backing: the status colours are tints, unreadable over footage. */}
                  <span className="absolute top-2 left-2 rounded-full bg-background/95 shadow-sm">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                        status.className
                      )}
                    >
                      {settled ? null : (
                        <Loader2 className="size-3 animate-spin" aria-hidden />
                      )}
                      {status.label}
                    </span>
                  </span>
                </div>
                <div className="grid gap-1 p-3 pr-10">
                  <span className="line-clamp-2 text-sm font-medium">
                    {job.topic ?? "Working out the topic"}
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {job.hasVideo ? (
                      <Video className="size-3.5" aria-label="Video" />
                    ) : (
                      <AudioLines className="size-3.5" aria-label="Audio" />
                    )}
                    <time
                      dateTime={job.createdAt}
                      title={new Date(job.createdAt).toUTCString()}
                      suppressHydrationWarning
                    >
                      {ago(job.createdAt, now)}
                    </time>
                  </span>
                </div>
              </Link>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-1.5 bottom-2 size-8"
                    aria-label={`More actions for ${job.topic ?? "this video"}`}
                  >
                    <MoreVertical />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={!settled}
                    onSelect={() => setPendingDelete(job)}
                  >
                    <Trash2 /> {settled ? "Delete" : "Delete when finished"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ul>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this video?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.topic ?? "This video"}, its Hindi version and all of the
              reasoning behind it will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(event) => {
                // Keep the dialog open until the delete has actually happened.
                event.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? "Deleting" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
