import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { JobList } from "@/components/localize/job-list";
import { UploadForm } from "@/components/localize/upload-form";
import { apiFetchServer } from "@/lib/api/server";
import { jobsListResponse } from "@/lib/api/localize";

export const metadata: Metadata = { title: "Localize" };

/**
 * Upload and history. The list is read on the server with the caller's cookie
 * forwarded; the upload is a client form that navigates to the new job's page,
 * which does the polling.
 */
export default async function LocalizePage() {
  const { data: jobs } = await apiFetchServer("/api/v1/localize/jobs", jobsListResponse, {
    query: { limit: 20 },
  });

  return (
    <div className="grid gap-10">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Localize a lecture</h1>
        <p className="max-w-2xl text-muted-foreground">
          Upload English teaching audio. You get it back in Hindi, keeping what the
          teacher defined, stressed and warned about, with the reasoning behind every
          choice. Want to see a finished one first?{" "}
          <Link href="/demo" className="font-medium text-primary hover:underline">
            Open the demo lecture
          </Link>
          .
        </p>
      </div>

      <Card>
        <CardContent>
          <UploadForm />
        </CardContent>
      </Card>

      <section className="grid gap-3" aria-labelledby="jobs-heading">
        <h2 id="jobs-heading" className="text-lg font-semibold tracking-tight">
          Your clips
        </h2>
        <JobList jobs={jobs} />
      </section>
    </div>
  );
}
