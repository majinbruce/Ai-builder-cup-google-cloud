import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { JobList } from "@/components/localize/job-list";
import { UploadDialog } from "@/components/localize/upload-dialog";
import { UploadForm } from "@/components/localize/upload-form";
import { apiFetchServer } from "@/lib/api/server";
import { jobsListResponse } from "@/lib/api/localize";

export const metadata: Metadata = { title: "My videos" };

/**
 * The library. The list is read on the server with the caller's cookie
 * forwarded; each card opens the video's watch page. An empty library shows
 * the uploader inline, since uploading is the only thing to do there; once
 * there are videos it moves behind the "Upload video" button.
 */
export default async function LocalizePage() {
  const { data: jobs } = await apiFetchServer("/api/v1/localize/jobs", jobsListResponse, {
    query: { limit: 50 },
  });

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">My videos</h1>
          <p className="text-muted-foreground">
            English lectures, re-taught in Hindi.{" "}
            <Link href="/demo" className="font-medium text-primary hover:underline">
              See a finished one
            </Link>
          </p>
        </div>
        {jobs.length === 0 ? null : <UploadDialog />}
      </div>

      {jobs.length === 0 ? (
        <Card>
          <CardContent>
            <UploadForm />
          </CardContent>
        </Card>
      ) : (
        <JobList jobs={jobs} />
      )}
    </div>
  );
}
