import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import type { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { config } from "../../config/index.ts";
import { AppError, badRequest } from "../../lib/errors.ts";
import {
  errorEnvelope,
  ok,
  paginated,
  paginatedEnvelope,
  successEnvelope,
} from "../../lib/api-response.ts";
import { requireUser } from "../../lib/require-user.ts";
import {
  MAX_RANGE_BYTES,
  capRange,
  fileSize,
  openReadStream,
  parseRangeHeader,
  writeStreamToFile,
} from "../../lib/storage.ts";
import * as localizeService from "./localize.service.ts";
import {
  ACCEPTED_UPLOAD_TYPE,
  CreateJobFromUploadBody,
  CreateUploadBody,
  DemoAudioParams,
  Job,
  JobAudioParams,
  JobIdParams,
  JobSummary,
  ListJobsQuery,
  UploadIdParams,
  UploadTarget,
} from "./localize.schemas.ts";

/**
 * ============================================================================
 * /api/v1/localize — the permission model, in full
 * ============================================================================
 *
 *   POST  /uploads                  auth    where to PUT a file (signed GCS URL); 201
 *   PUT   /uploads/:uploadId        auth    local backend only: the PUT target itself
 *   POST  /jobs/from-upload         auth    a finished upload becomes a job; 202
 *   POST  /jobs                     auth    multipart upload (≤ 32 MiB on Cloud Run); 202
 *   GET   /jobs                     auth    YOUR jobs, newest first
 *   GET   /jobs/:id                 owner   the full job; the UI polls this
 *   GET   /jobs/:id/audio/:which    owner   source or output mp3, Range-aware
 *   GET   /jobs/:id/video/:which    owner   source or output mp4, Range-aware
 *   GET   /demo                     public  the promoted demo job, full
 *   GET   /demo/audio/:which        public  its audio
 *   GET   /demo/video/:which        public  its video
 *
 * Uploads are under uploads/<userId>/<uploadId>: the caller's id is in the key,
 * so /jobs/from-upload with somebody else's upload id finds nothing.
 *
 * "owner" is enforced in the SQL WHERE clause (localize.repository.ts
 * findForUser), not by loading the row and comparing — so somebody else's job
 * id is a 404 indistinguishable from a random one, and there is no code path
 * that holds another user's row in memory. There is no admin override: nothing
 * in the demo needs one, and an admin who can read every uploaded lecture is a
 * feature to add on purpose rather than by symmetry with the users module.
 *
 * The demo routes are public because SPEC section h requires the deployed URL to
 * work signed-out for the demo job. They serve ONE row, chosen by a flag only
 * the promote-demo script sets, so a public route never takes an id from the
 * caller. That is why /demo returns the whole Job rather than an id to fetch
 * from /jobs/:id: the alternative is an owner-only route with a public
 * exception, which is the shape that leaks.
 */

/**
 * Uploads per user per hour, successful or not. Each one runs ffmpeg over up to
 * 25 MB, so refused uploads need a cap too. The real budget — jobs, which cost
 * model calls — is localizeService.JOBS_PER_HOUR, counted from the table.
 */
const UPLOADS_PER_HOUR = 20;

const jobEnvelope = successEnvelope(Job);
const commonErrors = { 400: errorEnvelope, 401: errorEnvelope, 500: errorEnvelope };

export interface LocalizeRoutesOptions {
  /** Overrides the real Gemini/TTS stages. The integration suite passes stubs. */
  stages?: localizeService.Stages;
}

/**
 * Streams one stored mp3 or mp4, honouring a single byte range.
 *
 * Range is not an optimisation here, it is a feature: the reasoning panel plays
 * one segment by seeking the player to that segment's start, and a media
 * element can only seek into a resource whose server answers ranges. Without
 * this, "play this segment" would restart the file from zero.
 */
async function sendMedia(
  request: FastifyRequest,
  reply: FastifyReply,
  uri: string,
  contentType: "audio/mpeg" | "video/mp4",
  cacheControl = "private, max-age=3600"
): Promise<FastifyReply> {
  const size = await fileSize(uri);
  const range = parseRangeHeader(request.headers.range, size);

  reply
    .header("accept-ranges", "bytes")
    .header("content-type", contentType)
    // Private by default: every one of these is behind a session except the
    // demo, and a shared cache keyed without the cookie would serve one user's
    // lecture to another.
    .header("cache-control", cacheControl);

  if (range === null) {
    return reply.code(416).header("content-range", `bytes */${size}`).send();
  }

  if (range === undefined) {
    // Under Cloud Run's 32 MiB cap a length can be declared; past it the body
    // must go chunked (no content-length), or Cloud Run answers 500.
    if (size <= MAX_RANGE_BYTES) reply.header("content-length", size);
    return reply.send(openReadStream(uri));
  }

  const piece = capRange(range);
  return reply
    .code(206)
    .header("content-range", `bytes ${piece.start}-${piece.end}/${size}`)
    .header("content-length", piece.end - piece.start + 1)
    .send(openReadStream(uri, piece));
}

const securedLocalizeRoutes: FastifyPluginAsyncZod<LocalizeRoutesOptions> = async (
  app,
  opts
) => {
  app.addHook("onRequest", app.requireAuth);

  /**
   * Scoped to this plugin, not registered globally: nothing else in the API
   * accepts a file, and a global multipart parser is an upload endpoint on every
   * route that forgets it exists.
   *
   * The cap is `limits.fileSize`, NOT Fastify's `bodyLimit`. Measured
   * 2026-09-07 (SPEC section b): bodyLimit does not apply to multipart at all,
   * because this plugin consumes the raw stream itself — a cap wired there would
   * be a cap that silently does nothing.
   */
  await app.register(multipart, {
    limits: {
      fileSize: config.limits.maxUploadBytes,
      files: 1,
      fields: 0,
      parts: 1,
    },
  });

  app.post(
    "/jobs",
    {
      config: {
        rateLimit: {
          max: UPLOADS_PER_HOUR,
          timeWindow: "1 hour",
          // Runs after this scope's requireAuth hook — route-level hooks always
          // follow instance-level ones — so request.user is set here, unlike
          // in the global limiter (see the note in plugins/security.ts).
          keyGenerator: (request) => `localize-jobs:${request.user?.id ?? request.ip}`,
        },
      },
      schema: {
        tags: ["localize"],
        summary: "Upload a clip and start a localization job",
        description:
          "multipart/form-data with one file part: audio/* or video/mp4, at most " +
          `${config.limits.maxUploadBytes} bytes and ${config.limits.maxClipSeconds} s.`,
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        response: {
          202: jobEnvelope,
          413: errorEnvelope,
          415: errorEnvelope,
          429: errorEnvelope,
          ...commonErrors,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);

      await localizeService.assertJobBudget({ db: app.db, log: request.log }, user.id);

      if (!request.isMultipart()) {
        throw new AppError("Upload the clip as multipart/form-data.", 415);
      }

      const part = await request.file();
      if (part === undefined) {
        throw badRequest("No file in the upload.", [
          { field: "file", message: "Choose an audio or video file." },
        ]);
      }

      if (!ACCEPTED_UPLOAD_TYPE.test(part.mimetype)) {
        // Drain what the client is sending, or the socket stalls on the unread body.
        part.file.resume();
        throw new AppError(
          `Unsupported file type "${part.mimetype}". Upload audio or an mp4 video.`,
          415,
          [{ field: "file", message: "Must be an audio file or an mp4 video." }]
        );
      }

      const uploadDir = await fsp.mkdtemp(path.join(os.tmpdir(), "localize-upload-"));

      try {
        const uploadPath = path.join(uploadDir, "upload");

        const mb = Math.floor(config.limits.maxUploadBytes / 1024 / 1024);
        const tooLarge = () =>
          new AppError(`The file is larger than ${mb} MB.`, 413, [
            { field: "file", message: `Files must be ${mb} MB or smaller.` },
          ]);

        try {
          await writeStreamToFile(part.file, uploadPath);
        } catch (err) {
          if (err instanceof app.multipartErrors.RequestFileTooLargeError)
            throw tooLarge();
          throw err;
        }

        /**
         * Checked as well as the error above, because measurement says the error
         * alone is not enough: an over-cap upload through a piped stream arrived
         * truncated WITHOUT the stream erroring, and the first sign of it was
         * ffmpeg refusing the cut-off file with a 400 about decoding. A 25 MB
         * lecture reported as "not audio" would be a lie about the user's file.
         */
        if (part.file.truncated) throw tooLarge();

        const ctx = { db: app.db, log: request.log };
        const { job } = await localizeService.createJobFromUpload(ctx, {
          userId: user.id,
          uploadPath,
          ...(opts.stages === undefined ? {} : { stages: opts.stages }),
        });

        return reply.code(202).send(ok(job, "Job queued"));
      } finally {
        await fsp.rm(uploadDir, { recursive: true, force: true });
      }
    }
  );

  /**
   * Direct upload, step 1. Shares the per-hour limiter's budget with the
   * multipart route in spirit but not in key: a direct upload makes two POSTs
   * (this and /jobs/from-upload), and counting both against one key would
   * halve the hour.
   */
  app.post(
    "/uploads",
    {
      config: {
        rateLimit: {
          max: UPLOADS_PER_HOUR,
          timeWindow: "1 hour",
          keyGenerator: (request) => `localize-uploads:${request.user?.id ?? request.ip}`,
        },
      },
      schema: {
        tags: ["localize"],
        summary: "Get a URL to upload a clip to directly",
        description:
          "Returns a V4 signed GCS PUT URL valid for 15 minutes. Send the file with " +
          "exactly the returned headers, then POST /jobs/from-upload with the uploadId. " +
          `At most ${config.limits.maxUploadBytes} bytes; audio/* or video/mp4.`,
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        body: CreateUploadBody,
        response: {
          201: successEnvelope(UploadTarget),
          413: errorEnvelope,
          429: errorEnvelope,
          ...commonErrors,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const ctx = { db: app.db, log: request.log };
      const target = await localizeService.createUpload(ctx, user.id, request.body);
      return reply.code(201).send(ok(target, "Upload URL created"));
    }
  );

  /**
   * The local backend's PUT target. Not registered with a bucket configured:
   * there the browser PUTs to GCS, and an API route accepting uploads would be
   * a way around the signed URL's length range.
   */
  if (config.gcs.bucket === null) {
    // Hand the raw body to the handler as a stream instead of buffering it.
    // bodyLimit does not apply to a passthrough parser; receiveLocalUpload
    // counts the bytes itself.
    app.addContentTypeParser(ACCEPTED_UPLOAD_TYPE, (_request, payload, done) => {
      done(null, payload);
    });

    app.put(
      "/uploads/:uploadId",
      {
        schema: {
          tags: ["localize"],
          summary: "Local development only: receive a direct upload",
          security: [{ cookieAuth: [] }, { bearerAuth: [] }],
          params: UploadIdParams,
          response: {
            200: successEnvelope(UploadIdParams),
            413: errorEnvelope,
            415: errorEnvelope,
            ...commonErrors,
          },
        },
      },
      async (request) => {
        const user = requireUser(request);
        const body = request.body as Readable | undefined;
        if (body === undefined || typeof body.pipe !== "function") {
          throw new AppError(
            "Send the file as the raw body with its audio/video type.",
            415
          );
        }
        await localizeService.receiveLocalUpload(user.id, request.params.uploadId, body);
        return ok({ uploadId: request.params.uploadId }, "Upload received");
      }
    );
  }

  app.post(
    "/jobs/from-upload",
    {
      config: {
        rateLimit: {
          max: UPLOADS_PER_HOUR,
          timeWindow: "1 hour",
          keyGenerator: (request) => `localize-jobs:${request.user?.id ?? request.ip}`,
        },
      },
      schema: {
        tags: ["localize"],
        summary: "Start a localization job from a finished direct upload",
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        body: CreateJobFromUploadBody,
        response: {
          202: jobEnvelope,
          404: errorEnvelope,
          413: errorEnvelope,
          429: errorEnvelope,
          ...commonErrors,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const ctx = { db: app.db, log: request.log };
      const { job } = await localizeService.createJobFromStoredUpload(ctx, {
        userId: user.id,
        uploadId: request.body.uploadId,
        ...(opts.stages === undefined ? {} : { stages: opts.stages }),
      });
      return reply.code(202).send(ok(job, "Job queued"));
    }
  );

  app.get(
    "/jobs",
    {
      schema: {
        tags: ["localize"],
        summary: "List your localization jobs",
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        querystring: ListJobsQuery,
        response: { 200: paginatedEnvelope(JobSummary), ...commonErrors },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const ctx = { db: app.db, log: request.log };
      const { data, ...meta } = await localizeService.listJobs(
        ctx,
        user.id,
        request.query
      );

      return paginated(data, meta, "Jobs retrieved");
    }
  );

  app.get(
    "/jobs/:id",
    {
      schema: {
        tags: ["localize"],
        summary: "Get one of your jobs (poll this until done or failed)",
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        params: JobIdParams,
        response: { 200: jobEnvelope, 404: errorEnvelope, ...commonErrors },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const ctx = { db: app.db, log: request.log };
      const job = await localizeService.getJob(ctx, user.id, request.params.id);

      return ok(job, "Job retrieved");
    }
  );

  app.get(
    "/jobs/:id/audio/:which",
    {
      schema: {
        tags: ["localize"],
        summary: "Stream a job's source or synthesized audio (Range-aware)",
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        params: JobAudioParams,
        // 200/206 are raw audio, so no serializer schema; only failures are JSON.
        response: { 404: errorEnvelope, ...commonErrors },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const ctx = { db: app.db, log: request.log };
      const job = await localizeService.getJob(ctx, user.id, request.params.id);

      return sendMedia(
        request,
        reply,
        localizeService.audioUriFor(job, request.params.which),
        "audio/mpeg"
      );
    }
  );

  app.get(
    "/jobs/:id/video/:which",
    {
      schema: {
        tags: ["localize"],
        summary: "Stream a job's source or Hindi video (Range-aware)",
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        params: JobAudioParams,
        response: { 404: errorEnvelope, ...commonErrors },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const ctx = { db: app.db, log: request.log };
      const job = await localizeService.getJob(ctx, user.id, request.params.id);

      return sendMedia(
        request,
        reply,
        localizeService.videoUriFor(job, request.params.which),
        "video/mp4"
      );
    }
  );
};

const publicDemoRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/demo",
    {
      schema: {
        tags: ["localize"],
        summary: "The pre-computed demo job, readable signed-out",
        response: { 200: jobEnvelope, 404: errorEnvelope, 500: errorEnvelope },
      },
    },
    async (request) => {
      const job = await localizeService.getDemoJob({ db: app.db, log: request.log });
      return ok(job, "Demo job retrieved");
    }
  );

  app.get(
    "/demo/audio/:which",
    {
      schema: {
        tags: ["localize"],
        summary: "The demo job's audio (Range-aware)",
        params: DemoAudioParams,
        response: { 400: errorEnvelope, 404: errorEnvelope, 500: errorEnvelope },
      },
    },
    async (request, reply) => {
      const job = await localizeService.getDemoJob({ db: app.db, log: request.log });
      return sendMedia(
        request,
        reply,
        localizeService.audioUriFor(job, request.params.which),
        "audio/mpeg",
        // Not cached: the URL stays the same when a different job is promoted,
        // and an hour-long max-age would keep playing the previous demo's audio.
        "no-cache"
      );
    }
  );

  app.get(
    "/demo/video/:which",
    {
      schema: {
        tags: ["localize"],
        summary: "The demo job's video (Range-aware)",
        params: DemoAudioParams,
        response: { 400: errorEnvelope, 404: errorEnvelope, 500: errorEnvelope },
      },
    },
    async (request, reply) => {
      const job = await localizeService.getDemoJob({ db: app.db, log: request.log });
      return sendMedia(
        request,
        reply,
        localizeService.videoUriFor(job, request.params.which),
        "video/mp4",
        "no-cache"
      );
    }
  );
};

const localizeRoutes: FastifyPluginAsyncZod<LocalizeRoutesOptions> = async (
  app,
  opts
) => {
  // Only `stages` is passed down. `opts` also carries the `prefix` this plugin
  // was mounted with, and handing that to a nested register applies it twice —
  // measured: the first e2e run found POST /jobs at /api/v1/localize/api/v1/localize/jobs.
  await app.register(securedLocalizeRoutes, {
    ...(opts.stages === undefined ? {} : { stages: opts.stages }),
  });
  await app.register(publicDemoRoutes);
};

export default localizeRoutes;
