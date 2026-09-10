import type { z } from "zod";
import { paginatedEnvelope, successEnvelope } from "@/lib/api/envelope";
import { apiFetch } from "@/lib/api/client";
import { jobSchema, jobSummarySchema, type Job } from "@/lib/api/schemas";

/**
 * The localize module's endpoints, for the browser. Mirrors
 * src/modules/localize/localize.routes.ts in the API, whose opening comment
 * has the permission table: jobs are owner-only, `/demo` is public.
 */
export const jobResponse = successEnvelope(jobSchema);
export const jobsListResponse = paginatedEnvelope(jobSummarySchema);

export type JobsListResponse = z.infer<typeof jobsListResponse>;

/**
 * Upload limits, restated for a fast refusal in the browser. The API enforces
 * them (25 MB via multipart's fileSize, 180 s via ffprobe after decoding);
 * these only save a user from uploading 40 MB to be told no.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_CLIP_SECONDS = 180;
export const ACCEPTED_UPLOAD_TYPES = "audio/*,video/mp4";

/** POST /api/v1/localize/jobs — multipart; answers 202 with the queued job. */
export async function createJob(file: File): Promise<Job> {
  const formData = new FormData();
  formData.append("file", file, file.name);

  const body = await apiFetch("/api/v1/localize/jobs", jobResponse, {
    method: "POST",
    formData,
  });
  return body.data;
}

/** GET /api/v1/localize/jobs/:id — owner only; the progress view polls this. */
export async function getJob(id: string, signal?: AbortSignal): Promise<Job> {
  const body = await apiFetch(`/api/v1/localize/jobs/${id}`, jobResponse, {
    ...(signal ? { signal } : {}),
  });
  return body.data;
}

/**
 * Where a job's audio streams from. A plain URL for an <audio src>, not a
 * fetch: the element sends its own Range requests, which is what lets the
 * reasoning panel seek to one segment. `demo` selects the public route.
 */
export function audioUrl(
  job: { id: string },
  which: "source" | "output",
  options: { demo?: boolean } = {}
): string {
  return options.demo === true
    ? `/api/v1/localize/demo/audio/${which}`
    : `/api/v1/localize/jobs/${job.id}/audio/${which}`;
}
