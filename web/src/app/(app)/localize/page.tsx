import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { JobList } from "@/components/localize/job-list";
import { UploadDialog } from "@/components/localize/upload-dialog";
import { Scramble } from "@/components/nua/scramble";
import { apiFetchServer } from "@/lib/api/server";
import { jobsListResponse } from "@/lib/api/localize";

export const metadata: Metadata = { title: "My videos" };

/**
 * The library. The list is read on the server with the caller's cookie
 * forwarded; each row opens the video's watch page. The dropzone above it is
 * the way in for a new lecture.
 */
export default async function LocalizePage() {
  const { data: jobs } = await apiFetchServer("/api/v1/localize/jobs", jobsListResponse, {
    query: { limit: 50 },
  });

  return (
    <div className="nua-page px-(--gutter) pb-10">
      <Link
        href="/"
        aria-label="Back to the main page"
        title="Back"
        className="flex size-11 items-center justify-center border border-cream/40 transition-colors hover:border-cream hover:bg-cream hover:text-ink nua-focus"
      >
        <ArrowLeft className="size-[18px]" strokeWidth={1.5} />
      </Link>
      <h1 className="nua-display mt-10 text-[max(44px,4.6vw)] leading-none">
        My{" "}
        <em>
          <Scramble word="videos" />
        </em>
      </h1>
      <p className="nua-lead mt-[18px] text-cream/62">
        English lectures, re-taught in Hindi.{" "}
        <Link href="/demo" className="border-b border-cream text-cream hover:opacity-75">
          See a finished one
        </Link>
      </p>

      <div className="mt-10">
        <UploadDialog />
      </div>

      <div className="mt-14">
        {jobs.length === 0 ? (
          <p className="text-[15px] text-stone">
            Nothing here yet. A one-minute lecture takes about four minutes to re-teach.
          </p>
        ) : (
          <JobList jobs={jobs} />
        )}
      </div>
    </div>
  );
}
