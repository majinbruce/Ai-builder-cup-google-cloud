import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
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
  fileSize,
  openReadStream,
  parseRangeHeader,
  writeStreamToFile,
} from "../../lib/storage.ts";
import * as localizeService from "./localize.service.ts";
import {
  DemoAudioParams,
  Job,
  JobAudioParams,
  JobIdParams,
  JobSummary,
  ListJobsQuery,
} from "./localize.schemas.ts";

/**
 * ============================================================================
 * /api/v1/localize — the permission model, in full
 * ============================================================================
 *
 *   POST  /jobs                     auth    upload a clip; 202 with the queued job
 *   GET   /jobs                     auth    YOUR jobs, newest first
 *   GET   /jobs/:id                 owner   the full job; the UI polls this
 *   GET   /jobs/:id/audio/:which    owner   source or output mp3, Range-aware
 *   GET   /demo                     public  the promoted demo job, full
 *   GET   /demo/audio/:which        public  its audio
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

const ACCEPTED_TYPES = /^(audio\/[\w.+-]+|video\/mp4)$/;

const jobEnvelope = successEnvelope(Job);
const commonErrors = { 400: errorEnvelope, 401: errorEnvelope, 500: errorEnvelope };

export interface LocalizeRoutesOptions {
  /** Overrides the real Gemini/TTS stages. The integration suite passes stubs. */
  stages?: localizeService.Stages;
}

/**
 * Streams one stored mp3, honouring a single byte range.
 *
 * Range is not an optimisation here, it is a feature: the reasoning panel plays
 * one segment by seeking the player to that segment's start, and a media
 * element can only seek into a resource whose server answers ranges. Without
 * this, "play this segment" would restart the file from zero.
 */
async function sendAudio(
  request: FastifyRequest,
  reply: FastifyReply,
  uri: string,
  cacheControl = "private, max-age=3600"
): Promise<FastifyReply> {
  const size = await fileSize(uri);
  const range = parseRangeHeader(request.headers.range, size);

  reply
    .header("accept-ranges", "bytes")
    .header("content-type", "audio/mpeg")
    // Private by default: every one of these is behind a session except the
    // demo, and a shared cache keyed without the cookie would serve one user's
    // lecture to another.
    .header("cache-control", cacheControl);

  if (range === null) {
    return reply.code(416).header("content-range", `bytes */${size}`).send();
  }

  if (range === undefined) {
    return reply.header("content-length", size).send(openReadStream(uri));
  }

  return reply
    .code(206)
    .header("content-range", `bytes ${range.start}-${range.end}/${size}`)
    .header("content-length", range.end - range.start + 1)
    .send(openReadStream(uri, range));
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

      if (!ACCEPTED_TYPES.test(part.mimetype)) {
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

      return sendAudio(
        request,
        reply,
        localizeService.audioUriFor(job, request.params.which)
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
      return sendAudio(
        request,
        reply,
        localizeService.audioUriFor(job, request.params.which),
        // Not cached: the URL stays the same when a different job is promoted,
        // and an hour-long max-age would keep playing the previous demo's audio.
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
