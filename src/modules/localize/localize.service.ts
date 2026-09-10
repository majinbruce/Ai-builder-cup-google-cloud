import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../../config/index.ts";
import type { Database } from "../../plugins/db.ts";
import { badRequest, notFound } from "../../lib/errors.ts";
import { encodeMp3, measureMeanVolumeDb, probeDurationSec } from "../../lib/ffmpeg.ts";
import { downloadFile, jobKey, putFile } from "../../lib/storage.ts";
import { runAdapt, runAdaptRetry, runBrief, TARGET_LANGUAGE } from "./adapt.stage.ts";
import { runAnalyze } from "./analyze.stage.ts";
import { runCritique, selectForRetry } from "./critique.stage.ts";
import { runSynthesize } from "./synthesize.stage.ts";
import * as repo from "./localize.repository.ts";
import type {
  AudioWhich,
  Job,
  JobSummary,
  ListJobsQuery,
  ModelCall,
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

/** A job untouched for this long while in flight belongs to a dead process. */
export const STALE_JOB_MS = 10 * 60 * 1000;

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

    const row = await repo.insert(ctx.db, {
      id,
      userId,
      targetLanguage: TARGET_LANGUAGE,
      sourceUri,
    });

    ctx.log.info({ jobId: id, durationSec, meanVolumeDb }, "localize job queued");

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
    const selected = selectForRetry(critique, adaptation);

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
    const { synthesis } = await stages.synthesize({
      analysis: analyzed.analysis,
      adaptation,
      outDir: path.join(workDir, "synth"),
    });

    const audioUri = await putFile(synthesis.audioUri, jobKey(jobId, "output.mp3"));

    await repo.updateStage(db, jobId, {
      status: "done",
      // The stage reports the path it wrote in its scratch dir, which is about
      // to be deleted. What the row needs is where the file now lives.
      synthesis: { ...synthesis, audioUri },
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
    // then sits in flight until failStaleJobs() reaps it on the next boot,
    // which is the same recovery path as a crash.
    await repo
      .markFailed(db, jobId, message.slice(0, MAX_ERROR_CHARS))
      .catch((markErr: unknown) => {
        log.error({ err: markErr }, "could not mark localize job failed");
      });
  } finally {
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
 * Boot-time recovery, per SPEC section g: jobs run in-process, so one that was
 * in flight when its process died will never finish. Called from server.ts after
 * listen rather than from a hook, because the unit suite boots the app with no
 * database behind it.
 */
export async function failStaleJobs(ctx: Ctx): Promise<void> {
  const ids = await repo.failStale(ctx.db, new Date(Date.now() - STALE_JOB_MS));
  if (ids.length > 0) {
    ctx.log.warn({ jobIds: ids }, "marked orphaned localize jobs failed");
  }
}
