import type { z } from "zod";
import { ApiError, paginatedEnvelope, successEnvelope } from "@/lib/api/envelope";
import { apiFetch } from "@/lib/api/client";
import {
  jobSchema,
  jobSummarySchema,
  uploadTargetSchema,
  type Job,
  type UploadTarget,
} from "@/lib/api/schemas";

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
 * them (100 MiB in the signed URL's length range, 180 s via ffprobe after
 * decoding); these only save a user from uploading 150 MB to be told no.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_CLIP_SECONDS = 180;
export const ACCEPTED_UPLOAD_TYPES = "audio/*,video/mp4";

const uploadTargetResponse = successEnvelope(uploadTargetSchema);

/**
 * PUTs the file where the API said to, reporting progress.
 *
 * XMLHttpRequest rather than fetch: fetch has no upload progress, and a 100 MB
 * lecture on a slow link with no progress looks exactly like a hang. In
 * production the URL is a signed GCS URL on another origin, so no cookie goes
 * with it (withCredentials stays false); locally it is the API's own PUT route
 * on this origin, where the session cookie goes along by default.
 */
function putFile(
  target: UploadTarget,
  file: File,
  onProgress: (fraction: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.url);
    for (const [name, value] of Object.entries(target.headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      // GCS answers a length-range violation with 400 and an EntityTooLarge
      // XML body; the local route answers 413. Both become a 413 here, which
      // the form shows under the file field.
      const tooLarge = xhr.status === 413 || xhr.responseText.includes("EntityTooLarge");
      reject(
        new ApiError(
          tooLarge
            ? "The file is larger than the upload limit."
            : `The upload was refused (${xhr.status}). Try again.`,
          { status: tooLarge ? 413 : xhr.status }
        )
      );
    };
    xhr.onerror = () =>
      reject(new ApiError("The upload failed. Check your connection.", { status: 0 }));
    xhr.send(file);
  });
}

/**
 * Upload a clip and start its job, in the three steps the API asks for: get a
 * signed URL, PUT the bytes straight to Cloud Storage, then turn the upload
 * into a job. The bytes never pass through our services, which is what lets a
 * file be larger than Cloud Run's 32 MiB request cap.
 */
export async function createJob(
  file: File,
  onProgress: (fraction: number) => void = () => undefined
): Promise<Job> {
  const target = await apiFetch("/api/v1/localize/uploads", uploadTargetResponse, {
    method: "POST",
    body: { contentType: file.type, sizeBytes: file.size },
  });

  await putFile(target.data, file, onProgress);

  const body = await apiFetch("/api/v1/localize/jobs/from-upload", jobResponse, {
    method: "POST",
    body: { uploadId: target.data.uploadId },
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

/** Where a job's video streams from. Same Range story as audioUrl. */
export function videoUrl(
  job: { id: string },
  which: "source" | "output",
  options: { demo?: boolean } = {}
): string {
  return options.demo === true
    ? `/api/v1/localize/demo/video/${which}`
    : `/api/v1/localize/jobs/${job.id}/video/${which}`;
}
