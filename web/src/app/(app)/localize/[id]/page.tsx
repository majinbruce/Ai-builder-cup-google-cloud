import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JobView } from "@/components/localize/job-view";
import { ApiError } from "@/lib/api/envelope";
import { jobResponse } from "@/lib/api/localize";
import { apiFetchServer } from "@/lib/api/server";
import type { Job } from "@/lib/api/schemas";

export const metadata: Metadata = { title: "Localization job" };

/** The job, or null when the API says it does not exist for this caller. */
async function loadJob(id: string): Promise<Job | null> {
  try {
    const { data } = await apiFetchServer(`/api/v1/localize/jobs/${id}`, jobResponse);
    return data;
  } catch (error) {
    // 404: not yours or not real — the API does not distinguish, nor do we.
    // 400: not a UUID, which is the same answer to a person typing URLs.
    if (error instanceof ApiError && (error.isNotFound || error.status === 400)) {
      return null;
    }
    throw error;
  }
}

/**
 * One job. The first render comes from the server, so a finished job paints
 * complete with no spinner; JobView then polls from the browser while it runs.
 */
export default async function JobPage({ params }: PageProps<"/localize/[id]">) {
  const { id } = await params;
  const job = await loadJob(id);

  if (job === null) notFound();

  return <JobView initialJob={job} />;
}
