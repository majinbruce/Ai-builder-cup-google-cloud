"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AudioLines, MoreVertical, Trash2, Video } from "lucide-react";
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

const STATUS: Record<JobStatus, { label: string; color: string }> = {
  queued: { label: "Queued", color: "rgb(255 231 206 / 40%)" },
  ingesting: { label: "Preparing", color: "#ffe56e" },
  analyzing: { label: "Listening", color: "#ffe56e" },
  adapting: { label: "Re-teaching", color: "#ffe56e" },
  critiquing: { label: "Checking", color: "#ffe56e" },
  synthesizing: { label: "Voicing", color: "#ffe56e" },
  done: { label: "Ready", color: "#bfc26a" },
  failed: { label: "Failed", color: "#cb4e39" },
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
 * Your videos as rows: a frame of the footage (or an audio mark), the topic
 * once Gemini has named it, the status and the length.
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
      <div className="grid grid-cols-[minmax(0,1fr)_48px] gap-6 border-b border-cream/14 pb-3 text-[13px] text-cream/50 sm:grid-cols-[minmax(0,1fr)_140px_120px_48px]">
        <span>Name</span>
        <span className="hidden sm:block">Status</span>
        <span className="hidden sm:block">Duration</span>
        <span />
      </div>
      <ul>
        {jobs.map((job) => {
          const status = STATUS[job.status];
          const settled = SETTLED.includes(job.status);
          return (
            <li
              key={job.id}
              className="relative grid grid-cols-[minmax(0,1fr)_48px] items-center gap-6 border-b border-cream/10 py-[18px] transition-colors hover:bg-panel-2 sm:grid-cols-[minmax(0,1fr)_140px_120px_48px]"
            >
              <Link
                href={`/localize/${job.id}`}
                className="flex min-w-0 items-center gap-5 after:absolute after:inset-0 nua-focus"
              >
                <span className="flex aspect-video w-[136px] shrink-0 items-center justify-center bg-panel-2">
                  {job.hasPoster ? (
                    // A plain <img>: the poster comes from our own API behind the
                    // session cookie, which next/image's optimizer would not send.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={posterUrl(job)} alt="" loading="lazy" className="size-full object-cover" />
                  ) : (
                    <AudioLines className="size-7 text-cream/40" aria-hidden />
                  )}
                </span>
                <span className="flex min-w-0 flex-col gap-1.5">
                  <span className="line-clamp-2 text-[17px] leading-[1.35]">
                    {job.topic ??
                      (job.status === "failed" ? "Untitled video" : "Working out the topic")}
                  </span>
                  <span className="flex items-center gap-2 text-[13px] text-cream/50">
                    {job.hasVideo ? (
                      <Video className="size-3.5" strokeWidth={1.3} aria-label="Video" />
                    ) : (
                      <AudioLines className="size-3.5" strokeWidth={1.3} aria-label="Audio" />
                    )}
                    <time
                      dateTime={job.createdAt}
                      title={new Date(job.createdAt).toUTCString()}
                      suppressHydrationWarning
                    >
                      {ago(job.createdAt, now)}
                    </time>
                    <span className="sm:hidden">· {status.label}</span>
                  </span>
                </span>
              </Link>
              <span className="hidden items-center gap-2 text-[14px] sm:flex">
                <span
                  aria-hidden
                  className={cn("size-[9px]", !settled && "animate-pulse")}
                  style={{ background: status.color }}
                />
                {status.label}
              </span>
              <span className="hidden text-[14px] tabular-nums text-cream/75 sm:block">
                {job.durationSec === null ? "—" : formatTime(job.durationSec)}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={`More actions for ${job.topic ?? "this video"}`}
                  className="relative z-1 flex size-9 items-center justify-center text-cream/70 hover:bg-cream/6 hover:text-cream nua-focus"
                >
                  <MoreVertical className="size-4" />
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
