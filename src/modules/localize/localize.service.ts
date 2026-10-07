import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../../config/index.ts";
import type { Database } from "../../plugins/db.ts";
import { AppError, badRequest, notFound } from "../../lib/errors.ts";
import {
  encodeMp3,
  measureMeanVolumeDb,
  extractPoster,
  muxVideoWithAudio,
  normalizeVideoLoudness,
  probeDurationSec,
  probeHasPlayableVideo,
} from "../../lib/ffmpeg.ts";
import {
  createUploadTarget,
  deleteFile,
  deleteJobFiles,
  downloadFile,
  fileSize,
  jobKey,
  parseStorageUri,
  putFile,
  uploadKey,
  uriForKey,
} from "../../lib/storage.ts";
import { runAdapt, runAdaptRetry, runBrief, TARGET_LANGUAGE } from "./adapt.stage.ts";
import { runAnalyze } from "./analyze.stage.ts";
import { runCritique, selectForRetry } from "./critique.stage.ts";
import { runSynthesize } from "./synthesize.stage.ts";
import * as repo from "./localize.repository.ts";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  AudioWhich,
  CreateUploadBody,
  Job,
  JobSummary,
  ListJobsQuery,
  ModelCall,
  UploadTarget,
} from "./localize.schemas.ts";

/**
 * ============================================================================
 * The pipeline as a service: ingest inside the request, everything else after.
 * ============================================================================
 *
 * This is src/scripts/pipeline.ts with the printing taken out and the database
 * put in. Same stage functions, same order, same retry rule — they were written
 * as exported module functions in Phases 1-3 precisely so that this file would
 * call them rather than copy them.
 *
 * The split between the request and the background is where the Cloud Run
 * constraint lands (SPEC section b, "Jobs run in-process after the POST
 * returns"). Ingest is cheap and its failures are the uploader's to fix — a clip
 * over the length cap, a file ffmpeg cannot decode, silence — so it runs before
 * the response and fails as a 400. Analysis onward takes minutes, so it runs
 * after the 202 and fails as a job row with `status: failed`, which the polling
 * UI renders.
 */

export interface Ctx {
  db: Database;
  log: FastifyBaseLogger;
}

/**
 * The five stage functions, injectable.
 *
 * Production uses the real ones. The integration suite passes stubs, so it can
 * drive a job from upload to `done` through the real routes, the real database
 * and the real storage without spending a Gemini call — which is what makes the
 * orchestration testable at all, since the real stages cost money and minutes.
 */
export interface Stages {
  analyze: typeof runAnalyze;
  brief: typeof runBrief;
  adapt: typeof runAdapt;
  critique: typeof runCritique;
  adaptRetry: typeof runAdaptRetry;
  synthesize: typeof runSynthesize;
}

export const defaultStages: Stages = {
  analyze: runAnalyze,
  brief: runBrief,
  adapt: runAdapt,
  critique: runCritique,
  adaptRetry: runAdaptRetry,
  synthesize: runSynthesize,
};

/**
 * Below this mean level a clip is treated as silence and refused.
 *
 * SPEC section g: "ffmpeg probe rejects silent files". -60 dBFS is far below any
 * speech recording (the fixture is ~-20) and above digital silence, so it
 * catches an empty track without second-guessing a quiet speaker.
 */
const SILENCE_FLOOR_DB = -60;

/**
 * The upload's video with its audio at the playback level stage 4 gives the
 * Hindi (PLAYBACK_LOUDNESS in ffmpeg.ts), so switching language does not jump
 * in volume. Best effort, like the poster: a file loudnorm cannot handle is
 * stored as uploaded, which plays, only at its own level.
 */
async function playableSourceVideo(
  ctx: Ctx,
  uploadPath: string,
  workDir: string
): Promise<string> {
  const normalized = path.join(workDir, "source.normalized.mp4");
  try {
    await normalizeVideoLoudness(uploadPath, normalized);
    return normalized;
  } catch (err) {
    ctx.log.warn(
      { err },
      "could not normalize the video's loudness; storing it as uploaded"
    );
    return uploadPath;
  }
}

/** A job untouched for this long while in flight belongs to a dead process. */
export const STALE_JOB_MS = 10 * 60 * 1000;

/** How often a live process looks for orphans, not only at boot. */
export const REAP_INTERVAL_MS = 60 * 1000;

/**
 * SPEC section g: a per-user budget, so one account cannot run up the bill.
 *
 * Counted from the table, not by the rate limiter: only uploads that became a
 * job cost model calls, so a clip refused as silent or too long must not use up
 * the hour. The route keeps a looser limiter in front for the ingest CPU.
 */
export const JOBS_PER_HOUR = 5;

/**
 * Ids of the jobs this process is running right now.
 *
 * What lets the reaper run on a timer: a job in this set is alive however long
 * its current stage takes, and shutdown knows exactly which rows it is about to
 * abandon.
 */
const runningJobs = new Set<string>();

/** The error text a failed job shows, capped so a stack of model output cannot fill the row. */
const MAX_ERROR_CHARS = 1_000;

export interface CreateJobInput {
  userId: string;
  /** The raw upload on local disk. The caller owns it and deletes it. */
  uploadPath: string;
  stages?: Stages;
}

export interface CreateJobOutput {
  job: Job;
  /**
   * Settles when the background run ends, either way. Never rejects. The route
   * ignores it — that is what "async after the POST returns" means — and it
   * exists for callers that need to know when a job is finished, which today is
   * nobody but is the difference between a testable runner and a fire-and-forget
   * one.
   */
  finished: Promise<void>;
}

/**
 * Stage 0, then hand off.
 *
 * Normalizes to 16 kHz mono mp3 (the format Gemini downsamples to anyway, so
 * nothing is lost and inline base64 stays under the 20 MB request cap), checks
 * the length and level against the caps, stores the result, and inserts the row.
 */
/**
 * Refuses a user who has already started JOBS_PER_HOUR jobs this hour.
 *
 * Called before the upload is read, so a refused user does not stream 25 MB
 * first. Two uploads racing past the check together can both succeed; with a
 * budget of five that is an overshoot of one, not a way around it.
 */
export async function assertJobBudget(ctx: Ctx, userId: string): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const started = await repo.countCreatedSince(ctx.db, userId, since);

  if (started >= JOBS_PER_HOUR) {
    throw new AppError(
      `You have started ${started} jobs in the last hour; the limit is ${JOBS_PER_HOUR}.`,
      429
    );
  }
}

export async function createJobFromUpload(
  ctx: Ctx,
  input: CreateJobInput
): Promise<CreateJobOutput> {
  const { userId, uploadPath, stages = defaultStages } = input;

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "localize-ingest-"));

  try {
    const normalized = path.join(workDir, "source.mp3");

    try {
      await encodeMp3(uploadPath, normalized);
    } catch {
      throw badRequest("That file could not be decoded as audio.", [
        { field: "file", message: "Not a decodable audio or video file." },
      ]);
    }

    const durationSec = await probeDurationSec(normalized);
    const maxSec = config.limits.maxClipSeconds;

    if (durationSec > maxSec) {
      throw badRequest(
        `The clip is ${Math.round(durationSec)} s long; the limit is ${maxSec} s.`,
        [{ field: "file", message: `Clips must be ${maxSec} seconds or shorter.` }]
      );
    }

    const meanVolumeDb = await measureMeanVolumeDb(normalized);

    if (meanVolumeDb < SILENCE_FLOOR_DB) {
      throw badRequest("The clip is silent.", [
        { field: "file", message: `No audible speech (mean level ${meanVolumeDb} dB).` },
      ]);
    }

    const id = randomUUID();
    const sourceUri = await putFile(normalized, jobKey(id, "source.mp3"));

    /**
     * The footage is kept as uploaded, so the job page can show the lecture and
     * stage 4 can put the Hindi under it. Only playable video counts: an mp3's
     * cover art is a "video stream" to ffprobe and must not make a video job. A
     * probe failure is not an ingest failure — the audio already decoded — so it
     * degrades to an audio-only job.
     */
    const hasVideo = await probeHasPlayableVideo(uploadPath).catch(() => false);
    const sourceVideoUri = hasVideo
      ? await putFile(
          await playableSourceVideo(ctx, uploadPath, workDir),
          jobKey(id, "source.mp4")
        )
      : undefined;

    // The library card's thumbnail. Optional in the same way: a frame that
    // will not extract leaves a card with an icon, not a refused upload.
    let posterUri: string | undefined;
    if (hasVideo) {
      const poster = path.join(workDir, "poster.jpg");
      posterUri = await extractPoster(uploadPath, poster, Math.min(2, durationSec / 4))
        .then(() => putFile(poster, jobKey(id, "poster.jpg")))
        .catch((err: unknown) => {
          ctx.log.warn({ err }, "could not extract a poster frame");
          return undefined;
        });
    }

    const row = await repo.insert(ctx.db, {
      id,
      userId,
      targetLanguage: TARGET_LANGUAGE,
      sourceUri,
      sourceDurationSec: durationSec,
      ...(sourceVideoUri === undefined ? {} : { sourceVideoUri }),
      ...(posterUri === undefined ? {} : { posterUri }),
    });

    ctx.log.info(
      { jobId: id, durationSec, meanVolumeDb, hasVideo },
      "localize job queued"
    );

    // Deliberately not awaited: the response goes out now and the pipeline runs
    // on. runJob never rejects, so there is no unhandled rejection to catch here.
    const finished = runJob(
      { db: ctx.db, log: ctx.log.child({ jobId: id }), stages },
      id
    );

    return { job: repo.toDto(row), finished };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

const tooLarge = (): AppError => {
  const mb = Math.floor(config.limits.maxUploadBytes / 1024 / 1024);
  return new AppError(`The file is larger than ${mb} MB.`, 413, [
    { field: "file", message: `Files must be ${mb} MB or smaller.` },
  ]);
};

/**
 * Step 1 of a direct upload: refuse early, then say where the bytes go.
 *
 * The budget and the declared size are checked HERE, before anything is
 * uploaded, so a refused user does not push 100 MB first. The declared size is
 * a claim; GCS enforces the real one through the signed length range, and
 * createJobFromStoredUpload checks the stored object again.
 */
export async function createUpload(
  ctx: Ctx,
  userId: string,
  body: CreateUploadBody
): Promise<UploadTarget> {
  await assertJobBudget(ctx, userId);
  if (body.sizeBytes > config.limits.maxUploadBytes) throw tooLarge();

  const uploadId = randomUUID();
  const target = await createUploadTarget(
    uploadKey(userId, uploadId),
    uploadId,
    body.contentType,
    config.limits.maxUploadBytes
  );
  return { uploadId, ...target };
}

/**
 * The local backend's stand-in for the signed GCS PUT: stream the body to the
 * upload's key, counting bytes, and refuse past the cap. Only reachable when no
 * bucket is configured (the route is not registered otherwise).
 */
export async function receiveLocalUpload(
  userId: string,
  uploadId: string,
  body: Readable
): Promise<void> {
  const location = parseStorageUri(uriForKey(uploadKey(userId, uploadId)));
  if (location.backend !== "local") {
    throw new Error("receiveLocalUpload called with a GCS bucket configured.");
  }

  /**
   * The count is a stage IN the pipeline, not a "data" listener on the body: a
   * listener switches the stream to flowing mode, and chunks emitted before the
   * file stream is attached are lost — measured, the first version stored 0
   * bytes. Past the cap it keeps READING and stops writing, then answers 413:
   * failing the pipeline destroys the request stream, and the client gets a
   * reset connection instead of the error (measured: the test hung).
   */
  let received = 0;
  const max = config.limits.maxUploadBytes;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(null, received > max ? undefined : chunk);
    },
  });

  await fsp.mkdir(path.dirname(location.filePath), { recursive: true });
  try {
    await pipeline(body, counter, fs.createWriteStream(location.filePath));
  } catch (err) {
    await fsp.rm(location.filePath, { force: true });
    throw err;
  }

  if (received > max) {
    await fsp.rm(location.filePath, { force: true });
    throw tooLarge();
  }
}

const isNotFound = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 404 || code === "ENOENT";
};

export interface CreateJobFromStoredUploadInput {
  userId: string;
  uploadId: string;
  stages?: Stages;
}

/**
 * Step 3 of a direct upload: the stored object becomes a job, through exactly
 * the same ingest as a multipart upload.
 *
 * The key is built from the CALLER's id, so an upload id belonging to someone
 * else simply is not found. The upload object is deleted afterwards whatever
 * happened: a refused clip has nothing left to retry from (the user picks a
 * different file), and an accepted one now lives under jobs/<id>/.
 */
export async function createJobFromStoredUpload(
  ctx: Ctx,
  input: CreateJobFromStoredUploadInput
): Promise<CreateJobOutput> {
  const { userId, uploadId, stages } = input;
  const uri = uriForKey(uploadKey(userId, uploadId));

  let size: number;
  try {
    size = await fileSize(uri);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    throw notFound("Upload not found. It may have expired; upload the file again.");
  }

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "localize-stored-upload-"));
  try {
    if (size > config.limits.maxUploadBytes) throw tooLarge();
    await assertJobBudget(ctx, userId);

    const uploadPath = path.join(workDir, "upload");
    await downloadFile(uri, uploadPath);

    return await createJobFromUpload(ctx, {
      userId,
      uploadPath,
      ...(stages === undefined ? {} : { stages }),
    });
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
    await deleteFile(uri).catch((err: unknown) => {
      ctx.log.warn({ err, uploadId }, "could not delete an ingested upload");
    });
  }
}

interface RunDeps extends Ctx {
  stages: Stages;
}

/**
 * Stages 1-4, persisting each artifact the moment it exists.
 *
 * Mirrors pipeline.ts line for line in order and in the retry rule: brief, then
 * adapt in order, then ONE critique, then at most one re-adapt of the segments
 * that failed the gate, with the second result kept regardless. What it adds is
 * a write after every stage, so a poll mid-run sees real partial results rather
 * than a spinner, and a failure leaves the artifacts that did succeed on the row
 * for the reader to inspect.
 *
 * Never throws. Everything is caught and becomes `status: failed` with the
 * message, because there is nobody awaiting this to catch it.
 */
export async function runJob(deps: RunDeps, jobId: string): Promise<void> {
  const { db, log, stages } = deps;
  const startedAt = performance.now();
  const elapsedMs = () => Math.round(performance.now() - startedAt);

  // Assigned inside the try: a mkdtemp failure (a full /tmp) must become a
  // failed job like any other error. Outside it, it would be an unhandled
  // rejection, which server.ts treats as fatal — one bad job would take the
  // whole API down with it.
  let workDir: string | null = null;

  runningJobs.add(jobId);

  try {
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `localize-job-${jobId}-`));

    const row = await repo.findById(db, jobId);
    if (row?.sourceUri == null) {
      throw new Error(`Job ${jobId} has no source audio to process.`);
    }

    const audioPath = path.join(workDir, "source.mp3");
    await downloadFile(row.sourceUri, audioPath);

    const calls: ModelCall[] = [];

    /* Stage 1 — analyze ------------------------------------------------- */
    await repo.updateStage(db, jobId, { status: "analyzing" });

    const analyzed = await stages.analyze({ audioPath, logger: log });
    calls.push(analyzed.call);

    await repo.updateStage(db, jobId, {
      status: "adapting",
      analysis: analyzed.analysis,
      corroboration: analyzed.corroboration,
      calls,
    });
    log.info(
      { elapsedMs: elapsedMs(), segments: analyzed.analysis.segments.length },
      "localize analyze done"
    );

    /* Stage 2 — brief, then adapt in order ------------------------------ */
    const { brief, call: briefCall } = await stages.brief({
      analysis: analyzed.analysis,
      logger: log,
    });
    calls.push(briefCall);

    const adapted = await stages.adapt({
      analysis: analyzed.analysis,
      brief,
      logger: log,
    });
    calls.push(...adapted.calls);

    await repo.updateStage(db, jobId, {
      status: "critiquing",
      adaptation: adapted.adaptation,
      calls,
    });
    log.info({ elapsedMs: elapsedMs() }, "localize adapt done");

    /* Stage 3 — critique, then the one-shot retry ----------------------- */
    const { critique, call: critiqueCall } = await stages.critique({
      analysis: analyzed.analysis,
      adaptation: adapted.adaptation,
      logger: log,
    });
    calls.push(critiqueCall);

    // Written before the retry, so the scores are visible while it runs.
    await repo.updateStage(db, jobId, { critique, retriedIds: [], calls });

    let adaptation = adapted.adaptation;
    let retriedIds: string[] = [];
    const selected = selectForRetry(critique, adaptation, [], analyzed.analysis);

    if (selected.length > 0) {
      log.info(
        {
          segments: selected.map((entry) => ({
            id: entry.critique.id,
            why: entry.reasons,
          })),
        },
        "localize retrying segments that failed the critique gate"
      );

      const retry = await stages.adaptRetry({
        analysis: analyzed.analysis,
        adaptation,
        critiques: selected.map((entry) => entry.critique),
        logger: log,
      });
      adaptation = retry.adaptation;
      retriedIds = retry.retriedIds;
      calls.push(...retry.calls);
    }

    await repo.updateStage(db, jobId, {
      status: "synthesizing",
      adaptation,
      retriedIds,
      calls,
    });
    log.info({ elapsedMs: elapsedMs(), retriedIds }, "localize critique done");

    /* Stage 4 — synthesize, then store the mp3 -------------------------- */
    const { synthesis, masterFile } = await stages.synthesize({
      analysis: analyzed.analysis,
      adaptation,
      outDir: path.join(workDir, "synth"),
      // The output is padded to the source's full length, trailing silence included.
      sourceDurationSec: analyzed.evidence.durationSec,
      // Where the teacher paused: a take with time to spare waits there with them.
      pauses: analyzed.evidence.pauses,
    });

    const audioUri = await putFile(synthesis.audioUri, jobKey(jobId, "output.mp3"));

    /**
     * The lecture with the Hindi under it. Stage 4 placed every utterance on
     * the source timeline, which is what makes a straight mux line up with the
     * slides. A mux failure does NOT fail the job: the audio, the reasoning and
     * the side-by-side players are the product, and the video is a view of them.
     *
     * Muxed from the lossless master, so the voice is encoded once, to AAC, at
     * its own rate — not from the mp3, which would be a second lossy pass.
     */
    let outputVideoUri: string | undefined;
    if (row.sourceVideoUri !== null) {
      try {
        const sourceVideo = path.join(workDir, "source.mp4");
        const outputVideo = path.join(workDir, "output.mp4");
        await downloadFile(row.sourceVideoUri, sourceVideo);
        await muxVideoWithAudio(
          sourceVideo,
          masterFile ?? synthesis.audioUri,
          outputVideo
        );
        outputVideoUri = await putFile(outputVideo, jobKey(jobId, "output.mp4"));
      } catch (err) {
        log.error({ err }, "localize video mux failed; the job keeps its audio");
      }
    }

    await repo.updateStage(db, jobId, {
      status: "done",
      // The stage reports the path it wrote in its scratch dir, which is about
      // to be deleted. What the row needs is where the file now lives.
      synthesis: { ...synthesis, audioUri },
      ...(outputVideoUri === undefined ? {} : { outputVideoUri }),
    });

    log.info(
      {
        elapsedMs: elapsedMs(),
        outputSec: synthesis.durationSec,
        billedChars: synthesis.billedChars,
        inputTokens: sum(calls, "inputTokens"),
        outputTokens: sum(calls, "outputTokens"),
        thoughtTokens: sum(calls, "thoughtTokens"),
      },
      "localize job done"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, elapsedMs: elapsedMs() }, "localize job failed");

    // A failure to record the failure is logged and swallowed: the job row
    // then sits in flight until failStaleJobs() reaps it, which is the same
    // recovery path as a crash.
    await repo
      .markFailed(db, jobId, message.slice(0, MAX_ERROR_CHARS))
      .catch((markErr: unknown) => {
        log.error({ err: markErr }, "could not mark localize job failed");
      });
  } finally {
    runningJobs.delete(jobId);
    if (workDir !== null) {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

const sum = (calls: ModelCall[], key: "inputTokens" | "outputTokens" | "thoughtTokens") =>
  calls.reduce((total, call) => total + call[key], 0);

export async function getJob(ctx: Ctx, userId: string, id: string): Promise<Job> {
  const row = await repo.findForUser(ctx.db, id, userId);
  if (row === null) throw notFound("Job not found");
  return repo.toDto(row);
}

export async function listJobs(
  ctx: Ctx,
  userId: string,
  { page, limit }: ListJobsQuery
): Promise<{ data: JobSummary[]; page: number; limit: number; total: number }> {
  const { rows, total } = await repo.listForUser(ctx.db, userId, {
    limit,
    offset: (page - 1) * limit,
  });
  return { data: rows.map(repo.toSummary), page, limit, total };
}

/**
 * Deletes a job and every file it has. Owner only, through the same
 * WHERE-clause ownership as getJob, so another user's id is a 404.
 *
 * A job still running is refused: its runner holds the row and would go on
 * writing files under a prefix this has just emptied. Files go before the row,
 * so a failure between the two leaves a row that can be deleted again rather
 * than files nothing points at.
 */
export async function deleteJob(ctx: Ctx, userId: string, id: string): Promise<void> {
  const row = await repo.findForUser(ctx.db, id, userId);
  if (row === null) throw notFound("Job not found");
  if (row.status !== "done" && row.status !== "failed") {
    throw new AppError(
      "This video is still being localized. Delete it once it finishes.",
      409
    );
  }

  await deleteJobFiles(id);
  await repo.deleteForUser(ctx.db, id, userId);
  ctx.log.info({ jobId: id, wasDemo: row.isDemo }, "localize job deleted");
}

export async function getDemoJob(ctx: Ctx): Promise<Job> {
  const row = await repo.findDemo(ctx.db);
  if (row === null) {
    throw notFound(
      "No demo job has been promoted yet. Run one, then `npm run localize:promote-demo -- <jobId>`."
    );
  }
  return repo.toDto(row);
}

/**
 * Which stored file answers `/audio/:which` for a job, or a 404 if it does not
 * exist yet — a job still synthesizing has a source and no output.
 */
export function posterUriFor(job: Job): string {
  if (job.posterUri === null) throw notFound("This job has no poster frame.");
  return job.posterUri;
}

export function videoUriFor(job: Job, which: AudioWhich): string {
  const uri = which === "source" ? job.sourceVideoUri : job.outputVideoUri;
  if (uri === null) {
    throw notFound(
      job.sourceVideoUri === null
        ? "This job was made from an audio upload, so it has no video."
        : "This job has no Hindi video yet."
    );
  }
  return uri;
}

export function audioUriFor(job: Job, which: AudioWhich): string {
  const uri = which === "source" ? job.sourceUri : (job.synthesis?.audioUri ?? null);
  if (uri === null) {
    throw notFound(
      which === "output" ? "This job has no synthesized audio yet." : "No source audio."
    );
  }
  return uri;
}

/**
 * Orphan recovery, per SPEC section g: jobs run in-process, so one that was in
 * flight when its process died will never finish.
 *
 * Run at boot AND on a timer (server.ts). Boot alone is not enough: a job killed
 * a minute into its run is only a minute stale when the next process boots, so
 * a boot-only check skips it and nothing ever looks again — its owner's page
 * polls forever. This process's own running jobs are excluded, so the timer
 * cannot fail a job that is merely slow.
 */
export async function failStaleJobs(ctx: Ctx): Promise<void> {
  const ids = await repo.failStale(ctx.db, new Date(Date.now() - STALE_JOB_MS), [
    ...runningJobs,
  ]);
  if (ids.length > 0) {
    ctx.log.warn({ jobIds: ids }, "marked orphaned localize jobs failed");
  }
}

/**
 * Shutdown: fails every job this process is still running, because exiting is
 * about to kill them. Called while the database is still open, so the rows say
 * "failed" at once instead of waiting STALE_JOB_MS for the reaper.
 */
export async function failRunningJobs(ctx: Ctx): Promise<void> {
  const ids = await repo.failInFlight(ctx.db, [...runningJobs]);
  if (ids.length > 0) {
    ctx.log.warn({ jobIds: ids }, "shutting down: marked running localize jobs failed");
  }
}
