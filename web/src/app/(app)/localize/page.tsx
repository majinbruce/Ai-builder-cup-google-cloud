import type { Metadata } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    <div className="grid gap-8">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Localize a lecture</h1>
        <p className="text-sm text-muted-foreground">
          English educational audio, re-taught in Hindi — keeping what the teacher
          defined, stressed and warned about, with the reasoning for every non-literal
          choice.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New job</CardTitle>
        </CardHeader>
        <CardContent>
          <UploadForm />
        </CardContent>
      </Card>

      <section className="grid gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Your jobs</h2>
        <JobList jobs={jobs} />
      </section>
    </div>
  );
}
