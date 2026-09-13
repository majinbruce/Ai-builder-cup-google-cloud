import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers.ts";
import { createFakeMailer, type FakeMailer } from "../helpers/mailer.ts";
import { registerAndSignIn, type TestIdentity } from "../helpers/auth.ts";
import type { App } from "../../src/app.ts";
import { eq, inArray } from "drizzle-orm";
import { localizeJobs } from "../../src/db/schema.ts";
import * as repo from "../../src/modules/localize/localize.repository.ts";
import { setDemo } from "../../src/modules/localize/localize.repository.ts";
import {
  failRunningJobs,
  failStaleJobs,
  STALE_JOB_MS,
  type Stages,
} from "../../src/modules/localize/localize.service.ts";
import {
  AcousticEvidence,
  Analysis,
  Corroboration,
  Job,
  Synthesis,
  type Adaptation,
  type Critique,
  type ModelCall,
  type ModelCallStage,
} from "../../src/modules/localize/localize.schemas.ts";

const run = promisify(execFile);

/**
 * ============================================================================
 * The job lifecycle through the real routes, database and storage.
 * ============================================================================
 *
 * Everything real except the five stage functions, which are stubbed through
 * the same `Stages` seam production fills with the Gemini and TTS calls. That is
 * the split this file is for: the stages have their own tests and their own
 * paid e2e run (`npm run e2e:localize`), and what is left to prove here is the
 * orchestration around them — that a job moves forward through every status,
 * lands each artifact, fails cleanly, retries once, and is only ever visible to
 * its owner.
 */

const FIXTURE = path.resolve("fixtures/sample_60s.mp3");
const fixture = JSON.parse(
  fs.readFileSync("fixtures/analysis.expected.json", "utf8")
) as { analysis: unknown; evidence: unknown; corroboration: unknown };

const analysis = Analysis.parse(fixture.analysis);
const evidence = AcousticEvidence.parse(fixture.evidence);
const corroboration = Corroboration.parse(fixture.corroboration);

const call = (stage: ModelCallStage): ModelCall => ({
  stage,
  model: "stub",
  inputTokens: 10,
  outputTokens: 5,
  thoughtTokens: 0,
  latencyMs: 1,
});

/**
 * Mutable per test: which stage throws, which segments the critic fails, and an
 * optional gate analyze waits on — how a test holds a job mid-run.
 */
const behaviour = {
  throwIn: null as keyof Stages | null,
  failIds: [] as string[],
  analyzeGate: null as Promise<void> | null,
};

const adaptationFor = (marker: string): Adaptation => ({
  targetLanguage: "hi",
  brief: {
    topic: analysis.topic,
    audience: analysis.audience,
    instructorPersona: "stub",
    registerGuidance: "stub",
    glossary: [],
  },
  segments: analysis.segments.map((segment) => ({
    id: segment.id,
    targetText: `${marker} पाठ`,
    literalText: "stub",
    termsUsed: [],
    rationale: "stub",
    emphasisTerms: [],
    choices: [],
    ttsHints: { speakingRate: 1, pauseBefore: "none", style: "stub" },
  })),
});

const guard = (stage: keyof Stages) => {
  if (behaviour.throwIn === stage) throw new Error(`stub ${stage} exploded`);
};

const stages: Stages = {
  analyze: async () => {
    guard("analyze");
    await behaviour.analyzeGate;
    return { analysis, evidence, corroboration, call: call("analyze") };
  },
  brief: async () => {
    guard("brief");
    return { brief: adaptationFor("x").brief, call: call("brief") };
  },
  adapt: async () => {
    guard("adapt");
    return {
      adaptation: adaptationFor("पहला"),
      calls: analysis.segments.map(() => call("adapt")),
    };
  },
  critique: async () => {
    guard("critique");
    const critique: Critique = {
      overallFidelity: 90,
      overallNaturalness: 90,
      segments: analysis.segments.map((segment) => ({
        id: segment.id,
        backTranslation: "stub",
        fidelity: behaviour.failIds.includes(segment.id) ? 40 : 95,
        naturalness: 90,
        translationese: [],
        signalPreserved: true,
        emphasisPreserved: true,
        issues: [],
      })),
    };
    return { critique, call: call("critique") };
  },
  adaptRetry: async ({ adaptation, critiques }) => {
    guard("adaptRetry");
    const retried = new Set(critiques.map((critique) => critique.id));
    return {
      adaptation: {
        ...adaptation,
        segments: adaptation.segments.map((segment) =>
          retried.has(segment.id) ? { ...segment, targetText: "दूसरा पाठ" } : segment
        ),
      },
      calls: critiques.map(() => call("adapt_retry")),
      retriedIds: [...retried],
    };
  },
  synthesize: async ({ outDir }) => {
    guard("synthesize");
    fs.mkdirSync(outDir, { recursive: true });
    const audioUri = path.join(outDir, "output.mp3");
    fs.copyFileSync(FIXTURE, audioUri);
    const synthesis = Synthesis.parse({
      audioUri,
      durationSec: 63,
      voice: "stub",
      segments: analysis.segments.map((segment) => ({
        id: segment.id,
        startSec: segment.startSec,
        endSec: segment.endSec,
        voice: "stub",
        speakingRate: 1,
        markupUsed: "<speak>stub</speak>",
        inputMode: "ssml",
        measuredDurationSec: segment.endSec - segment.startSec,
        billedChars: 10,
        latencyMs: 1,
        pauseBeforeMs: 0,
        emphasisNotFound: [],
        emphasisPausedTerm: null,
        emphasisNotRealized: [],
      })),
      billedChars: 10 * analysis.segments.length,
      measuredCharsPerSec: 12,
    });
    return { synthesis, segmentFiles: [] };
  },
};

/** A multipart body by hand — one file part, which is all the route accepts. */
const multipart = (bytes: Buffer, mimeType: string, filename = "clip.mp3") => {
  const boundary = `----localize-test-${randomUUID()}`;
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
          `filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
};

describe("localize job lifecycle", () => {
  let app: App;
  let mailer: FakeMailer;
  let tmpDir: string;
  const createdJobIds: string[] = [];

  const fixtureBytes = fs.readFileSync(FIXTURE);

  beforeAll(async () => {
    mailer = createFakeMailer();
    app = await buildTestApp(mailer, { localizeStages: stages });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "localize-it-"));
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const id of createdJobIds) {
      fs.rmSync(path.resolve("outputs", "storage", "jobs", id), {
        recursive: true,
        force: true,
      });
    }
  });

  /**
   * A fresh account per test. Not for isolation alone: every upload counts
   * against the five-an-hour budget, so one account shared across this file
   * would start getting 429s halfway down it.
   */
  const newUser = () => registerAndSignIn(app, mailer);

  /**
   * One account for the recovery tests below, which start four jobs between them
   * — under the budget — and would otherwise spend four more sign-ups.
   */
  let sharedUser: TestIdentity | null = null;
  const recoveryUser = async () => (sharedUser ??= await newUser());

  const upload = async (who: TestIdentity, bytes: Buffer, mimeType = "audio/mpeg") => {
    const body = multipart(bytes, mimeType);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/localize/jobs",
      headers: { cookie: who.cookie, ...body.headers },
      payload: body.payload,
    });
    if (res.statusCode === 202) createdJobIds.push(res.json<{ data: Job }>().data.id);
    return res;
  };

  const getJob = (who: TestIdentity, id: string) =>
    app.inject({
      method: "GET",
      url: `/api/v1/localize/jobs/${id}`,
      headers: { cookie: who.cookie },
    });

  /**
   * Polls until the job settles, collecting every status it was seen in.
   *
   * Every poll counts against the global per-IP limiter (RATE_LIMIT_MAX, shared
   * by the whole file since inject always comes from one address), so the
   * interval is 50 ms, not 10: at 10 ms this file alone crossed the limit and
   * sign-ups late in it started failing with 429.
   */
  const settle = async (who: TestIdentity, id: string) => {
    const seen: string[] = [];
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const res = await getJob(who, id);
      // Every poll is parsed, not just the last: the UI renders partial jobs.
      const parsed = Job.parse(res.json<{ data: unknown }>().data);
      if (seen.at(-1) !== parsed.status) seen.push(parsed.status);
      if (parsed.status === "done" || parsed.status === "failed") {
        return { job: parsed, seen };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`job ${id} never settled`);
  };

  it("runs an upload to done, persisting every artifact", async () => {
    const owner = await newUser();
    behaviour.throwIn = null;
    behaviour.failIds = [];

    const res = await upload(owner, fixtureBytes);

    expect(res.statusCode).toBe(202);
    const queued = Job.parse(res.json<{ data: unknown }>().data);
    expect(queued.status).toBe("queued");
    expect(queued.analysis).toBeNull();

    const { job, seen } = await settle(owner, queued.id);

    // Stubs are instant, so a poll may skip statuses — but never go backwards.
    const order = [
      "queued",
      "analyzing",
      "adapting",
      "critiquing",
      "synthesizing",
      "done",
    ];
    const positions = seen.map((status) => order.indexOf(status));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions).not.toContain(-1);

    expect(job.status).toBe("done");
    expect(job.error).toBeNull();
    expect(job.analysis?.segments).toHaveLength(analysis.segments.length);
    expect(job.corroboration).toEqual(corroboration);
    expect(job.adaptation?.segments[0]?.targetText).toBe("पहला पाठ");
    expect(job.critique?.segments).toHaveLength(analysis.segments.length);
    expect(job.retriedIds).toEqual([]);
    expect(job.synthesis?.audioUri).toContain(path.join("jobs", job.id, "output.mp3"));
    // analyze + brief + one adapt per segment + critique, and no retry.
    expect(job.calls.map((entry) => entry.stage)).toEqual([
      "analyze",
      "brief",
      ...analysis.segments.map(() => "adapt"),
      "critique",
    ]);
  });

  it("re-adapts a segment the critique failed, once, and says so", async () => {
    const owner = await newUser();
    behaviour.throwIn = null;
    behaviour.failIds = ["s02"];

    const res = await upload(owner, fixtureBytes);
    const { job } = await settle(owner, res.json<{ data: Job }>().data.id);

    expect(job.status).toBe("done");
    expect(job.retriedIds).toEqual(["s02"]);
    expect(job.adaptation?.segments.find((s) => s.id === "s02")?.targetText).toBe(
      "दूसरा पाठ"
    );
    expect(job.adaptation?.segments.find((s) => s.id === "s01")?.targetText).toBe(
      "पहला पाठ"
    );
    expect(job.calls.filter((entry) => entry.stage === "adapt_retry")).toHaveLength(1);
  });

  it("fails a job whose stage throws, keeping what succeeded before it", async () => {
    const owner = await newUser();
    behaviour.throwIn = "critique";
    behaviour.failIds = [];

    const res = await upload(owner, fixtureBytes);
    const { job } = await settle(owner, res.json<{ data: Job }>().data.id);

    expect(job.status).toBe("failed");
    expect(job.error).toBe("stub critique exploded");
    expect(job.analysis).not.toBeNull();
    expect(job.adaptation).not.toBeNull();
    expect(job.critique).toBeNull();
    expect(job.synthesis).toBeNull();

    behaviour.throwIn = null;
  });

  it("serves audio with HTTP ranges, and only to the owner", async () => {
    const owner = await newUser();
    const res = await upload(owner, fixtureBytes);
    const { job } = await settle(owner, res.json<{ data: Job }>().data.id);

    const ranged = await app.inject({
      method: "GET",
      url: `/api/v1/localize/jobs/${job.id}/audio/output`,
      headers: { cookie: owner.cookie, range: "bytes=100-199" },
    });

    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-range"]).toMatch(/^bytes 100-199\/\d+$/);
    expect(ranged.rawPayload.byteLength).toBe(100);

    const whole = await app.inject({
      method: "GET",
      url: `/api/v1/localize/jobs/${job.id}/audio/source`,
      headers: { cookie: owner.cookie },
    });

    expect(whole.statusCode).toBe(200);
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect(whole.headers["content-type"]).toBe("audio/mpeg");

    const outsider = await registerAndSignIn(app, mailer);
    const peek = await app.inject({
      method: "GET",
      url: `/api/v1/localize/jobs/${job.id}/audio/output`,
      headers: { cookie: outsider.cookie },
    });

    expect(peek.statusCode).toBe(404);
  });

  it("hides one user's job from another as a 404, not a 403", async () => {
    const owner = await newUser();
    const res = await upload(owner, fixtureBytes);
    const id = res.json<{ data: Job }>().data.id;
    await settle(owner, id);

    const outsider = await registerAndSignIn(app, mailer);

    expect((await getJob(outsider, id)).statusCode).toBe(404);
    expect((await getJob(outsider, randomUUID())).statusCode).toBe(404);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/localize/jobs",
      headers: { cookie: outsider.cookie },
    });
    expect(list.json<{ data: unknown[] }>().data).toEqual([]);
  });

  it("lists the owner's jobs newest first, with topic and segment count", async () => {
    const owner = await newUser();
    for (const id of [
      (await upload(owner, fixtureBytes)).json<{ data: Job }>().data.id,
      (await upload(owner, fixtureBytes)).json<{ data: Job }>().data.id,
    ]) {
      await settle(owner, id);
    }
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/localize/jobs?limit=2",
      headers: { cookie: owner.cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { createdAt: string; topic: string | null }[];
      meta: { total: number };
    }>();
    expect(body.data).toHaveLength(2);
    expect(body.meta.total).toBe(2);
    expect(body.data[0]?.topic).toBe(analysis.topic);
    expect(Date.parse(body.data[0]?.createdAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(body.data[1]?.createdAt ?? "")
    );
  });

  it("rejects a non-UUID job id with a 400", async () => {
    const owner = await newUser();
    const res = await getJob(owner, "not-a-uuid");
    expect(res.statusCode).toBe(400);
  });

  it("refuses a file that is not audio or mp4 with a 415", async () => {
    const owner = await newUser();
    const res = await upload(owner, Buffer.from("hello"), "text/plain");

    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ details: [{ field: "file" }] });
  });

  it("refuses a file ffmpeg cannot decode with a 400 on the file field", async () => {
    const owner = await newUser();
    const res = await upload(owner, Buffer.from("definitely not an mp3"));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ details: [{ field: "file" }] });
  });

  it("refuses a clip over the length cap with a 400, before any job exists", async () => {
    const owner = await newUser();
    const long = path.join(tmpDir, "long.mp3");
    await run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=181",
      "-ar",
      "16000",
      "-ac",
      "1",
      long,
    ]);

    const res = await upload(owner, fs.readFileSync(long));

    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(
      /181 s long; the limit is 180 s/
    );
  });

  it("refuses a silent clip with a 400", async () => {
    const owner = await newUser();
    const silent = path.join(tmpDir, "silent.mp3");
    await run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=16000:cl=mono",
      "-t",
      "5",
      silent,
    ]);

    const res = await upload(owner, fs.readFileSync(silent));

    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/silent/);
  });

  it("refuses a file over the size cap with a 413", async () => {
    const owner = await newUser();
    const res = await upload(owner, Buffer.alloc(26 * 1024 * 1024 + 1));

    expect(res.statusCode).toBe(413);
  });

  it("limits each user to five jobs an hour", async () => {
    const busy = await registerAndSignIn(app, mailer);
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await upload(busy, fixtureBytes)).statusCode);
    }

    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);

    // A different user has their own budget.
    const other = await registerAndSignIn(app, mailer);
    expect((await upload(other, fixtureBytes)).statusCode).toBe(202);
    // Seven real ffmpeg ingests; the 5 s default timed this out on a slow disk.
  }, 30_000);

  it("serves a promoted demo job signed-out, and nothing before one exists", async () => {
    const owner = await newUser();
    const before = await app.inject({ method: "GET", url: "/api/v1/localize/demo" });
    expect(before.statusCode).toBe(404);

    const res = await upload(owner, fixtureBytes);
    const { job } = await settle(owner, res.json<{ data: Job }>().data.id);
    expect(await setDemo(app.db, job.id)).toBe(true);

    const demo = await app.inject({ method: "GET", url: "/api/v1/localize/demo" });
    expect(demo.statusCode).toBe(200);
    expect(Job.parse(demo.json<{ data: unknown }>().data).id).toBe(job.id);

    const audio = await app.inject({
      method: "GET",
      url: "/api/v1/localize/demo/audio/output",
      headers: { range: "bytes=0-9" },
    });
    expect(audio.statusCode).toBe(206);
  });

  it("will not promote a job that is not done", async () => {
    const owner = await newUser();
    behaviour.throwIn = "analyze";
    const res = await upload(owner, fixtureBytes);
    const { job } = await settle(owner, res.json<{ data: Job }>().data.id);
    behaviour.throwIn = null;

    expect(job.status).toBe("failed");
    expect(await setDemo(app.db, job.id)).toBe(false);
  });

  it("replaces the previous demo when another job is promoted", async () => {
    const owner = await recoveryUser();
    const first = (
      await settle(
        owner,
        (await upload(owner, fixtureBytes)).json<{ data: Job }>().data.id
      )
    ).job;
    const second = (
      await settle(
        owner,
        (await upload(owner, fixtureBytes)).json<{ data: Job }>().data.id
      )
    ).job;

    // The later-finished job first, then the earlier one: before the fix the
    // earlier one stayed hidden behind the newer updated_at.
    expect(await setDemo(app.db, second.id)).toBe(true);
    expect(await setDemo(app.db, first.id)).toBe(true);

    const demo = await app.inject({ method: "GET", url: "/api/v1/localize/demo" });
    expect(Job.parse(demo.json<{ data: unknown }>().data).id).toBe(first.id);

    const audio = await app.inject({
      method: "GET",
      url: "/api/v1/localize/demo/audio/output",
    });
    expect(audio.headers["cache-control"]).toBe("no-cache");
  });

  it("does not count refused uploads against the hourly job budget", async () => {
    const busy = await registerAndSignIn(app, mailer);
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await upload(busy, Buffer.from("not audio"))).statusCode);
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await upload(busy, fixtureBytes)).statusCode);
    }

    expect(statuses).toEqual([400, 400, 400, 202, 202, 202, 202, 202, 429]);
  }, 30_000);

  it("reaps a job orphaned by a dead process, but not a fresh one", async () => {
    const owner = await recoveryUser();
    const insertOrphan = async (updatedAt: Date) => {
      const row = await repo.insert(app.db, {
        id: randomUUID(),
        userId: owner.userId,
        targetLanguage: "hi",
        sourceUri: path.resolve("outputs", "storage", "jobs", "none", "source.mp3"),
      });
      await app.db
        .update(localizeJobs)
        .set({ status: "adapting", updatedAt })
        .where(eq(localizeJobs.id, row.id));
      return row.id;
    };

    const stale = await insertOrphan(new Date(Date.now() - STALE_JOB_MS - 60_000));
    const fresh = await insertOrphan(new Date());

    await failStaleJobs({ db: app.db, log: app.log });

    expect((await repo.findById(app.db, stale))?.status).toBe("failed");
    expect((await repo.findById(app.db, fresh))?.status).toBe("adapting");

    // Hand-inserted rows still count against the shared account's hourly budget.
    await app.db.delete(localizeJobs).where(inArray(localizeJobs.id, [stale, fresh]));
  });

  it("fails running jobs on shutdown, and a later stage write cannot revive them", async () => {
    const owner = await recoveryUser();
    let release = () => {};
    behaviour.analyzeGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const id = (await upload(owner, fixtureBytes)).json<{ data: Job }>().data.id;

      for (let attempt = 0; attempt < 200; attempt += 1) {
        const polled = Job.parse(
          (await getJob(owner, id)).json<{ data: unknown }>().data
        );
        if (polled.status === "analyzing") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await failRunningJobs({ db: app.db, log: app.log });
      release();

      const { job } = await settle(owner, id);
      // Give the released run time to attempt its next writes.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = Job.parse((await getJob(owner, id)).json<{ data: unknown }>().data);

      expect(job.status).toBe("failed");
      expect(after.status).toBe("failed");
      expect(after.error).toMatch(/server restarted/);
    } finally {
      release();
      behaviour.analyzeGate = null;
    }
  });

  it("still lists jobs when one row's analysis no longer parses", async () => {
    const owner = await recoveryUser();
    const id = (await upload(owner, fixtureBytes)).json<{ data: Job }>().data.id;
    await settle(owner, id);
    await app.db
      .update(localizeJobs)
      .set({ analysis: { written: "by an older build" } })
      .where(eq(localizeJobs.id, id));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/localize/jobs",
      headers: { cookie: owner.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { topic: string | null }[] }>().data[0]?.topic).toBeNull();
  });
});
