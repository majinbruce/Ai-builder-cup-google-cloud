import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { config } from "../config/index.ts";
import { probeDurationSec } from "../lib/ffmpeg.ts";
import { Job } from "../modules/localize/localize.schemas.ts";
import type { JobStatus } from "../modules/localize/localize.schemas.ts";
import { fail, out } from "./print.ts";

/**
 * ============================================================================
 * The Phase 4 test: the whole product, through HTTP, on real models.
 * ============================================================================
 *
 *   npm run e2e:localize -- --email=e2e@local.test --password=... [clip.mp3]
 *     [--base=http://localhost:3000] [--origin=http://localhost:3001]
 *
 * Against the deployed stack, --base and --origin are both the web service's URL:
 * the browser only ever talks to that origin, and web/src/proxy.ts forwards
 * `/api/*` to the API, so that is the path worth testing.
 *
 * Needs a running API (`npm run dev`) and an account (`ADMIN_PASSWORD=...
 * npm run create-admin -- e2e@local.test --create` makes a verified one). Then it
 * does what the browser does — sign in, upload multipart, poll — and checks what
 * a browser cannot see:
 *
 *   - every poll response parses against the Job Zod schema, including the
 *     partial ones, because the UI renders those too;
 *   - the status only ever moves forward through the pipeline order;
 *   - the output audio answers a Range request with 206, which the per-segment
 *     play button depends on, and the full download is decodable audio.
 *
 * Exits non-zero on any of those, or on `failed`. The wall clock it prints is
 * the number SPEC section g's two-minute budget is judged against, measured from
 * the upload to `done` rather than per stage, because that is what a user waits.
 *
 * Arguments, not environment variables: CLAUDE.md rule 3 keeps process.env
 * inside src/config, and a local test account's password on a local command
 * line is not the secret that rule is protecting.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const base = flag("base") ?? `http://localhost:${config.server.port}`;
const origin = flag("origin") ?? config.auth.frontendUrl;
const email = flag("email") ?? "e2e@local.test";
const password = flag("password") ?? fail("--password=<password> is required.");
const clip = path.resolve(
  args.find((arg) => !arg.startsWith("--")) ?? "fixtures/sample_60s.mp3"
);

const POLL_MS = 2_000;
/** Generous: the Phase 3 cold run was 180 s. A job slower than this is broken, not slow. */
const TIMEOUT_MS = 8 * 60 * 1000;

const ORDER: JobStatus[] = [
  "queued",
  "ingesting",
  "analyzing",
  "adapting",
  "critiquing",
  "synthesizing",
  "done",
];

if (!fs.existsSync(clip)) fail(`No clip at ${clip}.`);

out();
out("  Phase 4 end-to-end — upload -> poll -> done, over HTTP");
out(`  api   ${base}  (origin ${origin})`);
out(`  user  ${email}`);
out(`  clip  ${path.relative(process.cwd(), clip)}`);
out();

/* -------------------------------------------------------------------------- */
/* Sign in                                                                    */
/* -------------------------------------------------------------------------- */

const signIn = await fetch(`${base}${config.auth.basePath}/sign-in/email`, {
  method: "POST",
  // Better Auth refuses a cookie-bearing request whose Origin it does not
  // trust. The frontend's origin is the trusted one, and it is what a browser
  // sends through the Next rewrite.
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ email, password }),
});

if (!signIn.ok) {
  fail(
    `Sign-in failed (${signIn.status}): ${await signIn.text()}\n` +
      `Create the account: ADMIN_PASSWORD=... npm run create-admin -- ${email} --create`
  );
}

const cookie = signIn.headers
  .getSetCookie()
  .map((header) => header.split(";")[0])
  .join("; ");

const authed = { cookie, origin };

/* -------------------------------------------------------------------------- */
/* Upload                                                                     */
/* -------------------------------------------------------------------------- */

const form = new FormData();
form.append(
  "file",
  new Blob([fs.readFileSync(clip)], { type: "audio/mpeg" }),
  path.basename(clip)
);

const startedAt = performance.now();
const elapsed = () => ((performance.now() - startedAt) / 1000).toFixed(1).padStart(6);

const upload = await fetch(`${base}/api/v1/localize/jobs`, {
  method: "POST",
  headers: authed,
  body: form,
});

const uploadBody: unknown = await upload.json();

if (upload.status !== 202) {
  fail(`Upload expected 202, got ${upload.status}: ${JSON.stringify(uploadBody)}`);
}

const queued = Job.parse((uploadBody as { data: unknown }).data);

out(`  ${elapsed()} s  POST /jobs -> 202, job ${queued.id}`);
out(`  ${elapsed()} s  ${queued.status}`);

/* -------------------------------------------------------------------------- */
/* Poll                                                                       */
/* -------------------------------------------------------------------------- */

let job = queued;
let lastStatus: JobStatus = queued.status;
const enteredAt = new Map<JobStatus, number>([[queued.status, performance.now()]]);
let polls = 0;

while (job.status !== "done" && job.status !== "failed") {
  if (performance.now() - startedAt > TIMEOUT_MS) {
    fail(`Timed out after ${TIMEOUT_MS / 1000} s in status "${job.status}".`);
  }

  await new Promise((resolve) => setTimeout(resolve, POLL_MS));

  const response = await fetch(`${base}/api/v1/localize/jobs/${queued.id}`, {
    headers: authed,
  });
  polls += 1;

  if (!response.ok)
    fail(`Poll ${polls} got ${response.status}: ${await response.text()}`);

  // Parsed on EVERY poll, not just the last: a partial job is what the UI draws
  // for most of the run, so a shape that only breaks mid-pipeline matters.
  const parsed = Job.safeParse(((await response.json()) as { data: unknown }).data);
  if (!parsed.success) {
    fail(
      `Poll ${polls}: response does not match the Job schema:\n${parsed.error.message}`
    );
  }
  job = parsed.data;

  if (job.status !== lastStatus) {
    if (
      job.status !== "failed" &&
      ORDER.indexOf(job.status) < ORDER.indexOf(lastStatus)
    ) {
      fail(`Status went backwards: ${lastStatus} -> ${job.status}.`);
    }

    const stageSec =
      (performance.now() - (enteredAt.get(lastStatus) ?? startedAt)) / 1000;
    out(
      `  ${elapsed()} s  ${job.status.padEnd(13)} (${lastStatus} took ${stageSec.toFixed(1)} s)`
    );
    enteredAt.set(job.status, performance.now());
    lastStatus = job.status;
  }
}

const wallClockSec = (performance.now() - startedAt) / 1000;

if (job.status === "failed") {
  fail(
    `\n  Job FAILED after ${wallClockSec.toFixed(1)} s:\n  ${job.error ?? "(no message)"}`
  );
}

/* -------------------------------------------------------------------------- */
/* Audio                                                                      */
/* -------------------------------------------------------------------------- */

const audioUrl = `${base}/api/v1/localize/jobs/${job.id}/audio/output`;

const ranged = await fetch(audioUrl, { headers: { ...authed, range: "bytes=0-1023" } });
const rangedBytes = (await ranged.arrayBuffer()).byteLength;

if (ranged.status !== 206 || rangedBytes !== 1024) {
  fail(
    `Range request expected 206 with 1024 bytes, got ${ranged.status} with ${rangedBytes}. ` +
      "The per-segment play button seeks, and seeking needs ranges."
  );
}

const full = await fetch(audioUrl, { headers: authed });
if (!full.ok) fail(`Output audio got ${full.status}.`);

fs.mkdirSync("outputs", { recursive: true });
const downloaded = path.join("outputs", "e2e-output.mp3");
fs.writeFileSync(downloaded, Buffer.from(await full.arrayBuffer()));
const downloadedSec = await probeDurationSec(downloaded);

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

const { analysis, adaptation, critique, synthesis, corroboration } = job;
if (analysis === null || adaptation === null || critique === null || synthesis === null) {
  fail("Job is done but a stage artifact is null.");
}

const sum = (key: "inputTokens" | "outputTokens" | "thoughtTokens") =>
  job.calls.reduce((total, call) => total + call[key], 0);

const sourceSpanSec =
  (analysis.segments.at(-1)?.endSec ?? 0) - (analysis.segments[0]?.startSec ?? 0);

out();
out("  --- result ---");
out(`  topic            ${analysis.topic}`);
out(`  segments         ${analysis.segments.length}`);
out(
  `  signals          ${analysis.segments.map((segment) => `${segment.id}:${segment.signal}`).join("  ")}`
);
if (corroboration !== null) {
  out(
    `  emphasis claims  ${corroboration.supportedByEnergy}/${corroboration.emphasisChecks.length} ` +
      "backed by a measured energy rise"
  );
}
out(`  glossary         ${adaptation.brief.glossary.length} terms`);
out(
  `  critique         fidelity ${critique.overallFidelity}, naturalness ${critique.overallNaturalness}`
);
out(
  `  retried          ${job.retriedIds === null || job.retriedIds.length === 0 ? "none" : job.retriedIds.join(", ")}`
);
out(
  `  audio            ${synthesis.durationSec.toFixed(1)} s Hindi vs ${sourceSpanSec.toFixed(1)} s ` +
    `source span, ${synthesis.billedChars} billed chars`
);
out(
  `  range request    206, ${rangedBytes} bytes; full download ffprobes at ${downloadedSec.toFixed(1)} s -> ${downloaded}`
);
out(
  `  model calls      ${job.calls.length}: ${sum("inputTokens")} in / ${sum("outputTokens")} out / ` +
    `${sum("thoughtTokens")} thinking`
);
out(`  polls            ${polls}, every one parsed against the Job schema`);
out();
out(`  WALL CLOCK, upload to done: ${wallClockSec.toFixed(1)} s`);
out(
  `  Demo budget is 120 s for a 60-90 s clip (SPEC section g). This run: ` +
    `${wallClockSec < 120 ? "inside it" : "OVER IT"}.`
);
out();
out(`  PASS — job ${job.id}`);
out(`  Browser: ${origin}/localize/${job.id}`);
out();
