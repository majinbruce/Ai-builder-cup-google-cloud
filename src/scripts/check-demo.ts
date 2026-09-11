import process from "node:process";
import { config } from "../config/index.ts";
import { Job } from "../modules/localize/localize.schemas.ts";
import { fail, out } from "./print.ts";

/**
 * ============================================================================
 * The Phase 5 check: what a judge gets from the public URL.
 * ============================================================================
 *
 *   npm run check:demo -- --base=https://localize-web-....run.app
 *     [--email=... --password=...] [--origin=<defaults to base's origin>]
 *
 * SPEC section h: "Public URL works signed-out for the demo job". Everything
 * here goes through the WEB origin, because that is the only origin a judge's
 * browser talks to — so a pass also proves web/src/proxy.ts forwards `/api/*`
 * to the API, status codes, Range and all.
 *
 *   1. GET /demo renders (200, HTML).
 *   2. GET /api/v1/localize/demo is a finished Job that parses against the Zod
 *      schema — the same parse the page does.
 *   3. Both demo audio files answer `Range: bytes=0-1023` with 206 and exactly
 *      1,024 bytes. The per-segment play button seeks, and seeking needs ranges.
 *   4. With --password: a 26 MiB upload through the web origin is a 413 from the
 *      API. Next's proxy buffers request bodies only up to
 *      `proxyClientMaxBodySize` and forwards the rest TRUNCATED, without failing.
 *      Measured 2026-09-11 with the limit left at Next's 10 MB default: this
 *      exact probe got a 500, and Next logged "Request body exceeded 10MB ...
 *      Only the first 10MB will be available". A 413 means the whole body
 *      arrived and the API's own cap is what refused it. Signed in because the route's auth hook answers 401
 *      before a byte of the body is read, which would prove nothing. Costs one
 *      of the account's 5 uploads per hour; creates no job.
 *
 * Exits non-zero on the first failure.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const base = (flag("base") ?? "http://localhost:3001").replace(/\/$/, "");
const email = flag("email") ?? "e2e@local.test";
const password = flag("password");
// Only differs from base's own origin when a local prod build runs on a spare
// port while the API trusts the usual dev frontend origin.
const origin = flag("origin") ?? new URL(base).origin;

const pass = (message: string): void => out(`  ok    ${message}`);

out();
out("  Phase 5 check — the public demo, signed out, through the web origin");
out(`  base  ${base}`);
out();

/* 1 — the page ------------------------------------------------------------ */

const page = await fetch(`${base}/demo`);
const html = await page.text();
if (page.status !== 200 || !html.includes("<html")) {
  fail(`GET /demo expected 200 HTML, got ${page.status}.`);
}
if (html.includes("No demo yet")) {
  fail("GET /demo rendered the 'No demo yet' state: no job has been promoted.");
}
pass(`GET /demo -> 200, ${(html.length / 1024).toFixed(0)} KB of HTML`);

/* 2 — the job ------------------------------------------------------------- */

const demo = await fetch(`${base}/api/v1/localize/demo`);
if (demo.status !== 200) fail(`GET /api/v1/localize/demo -> ${demo.status}.`);

const parsed = Job.safeParse(((await demo.json()) as { data: unknown }).data);
if (!parsed.success)
  fail(`Demo job does not match the Job schema:\n${parsed.error.message}`);
const job = parsed.data;
if (job.status !== "done") fail(`Demo job is "${job.status}", not "done".`);

pass(
  `GET /api/v1/localize/demo -> job ${job.id}, done, ` +
    `${job.analysis?.segments.length ?? 0} segments, ${job.calls.length} model calls, ` +
    `fidelity ${job.critique?.overallFidelity ?? "?"} / naturalness ` +
    `${job.critique?.overallNaturalness ?? "?"}`
);

/* 3 — the audio ----------------------------------------------------------- */

for (const which of ["source", "output"] as const) {
  const url = `${base}/api/v1/localize/demo/audio/${which}`;
  const ranged = await fetch(url, { headers: { range: "bytes=0-1023" } });
  const bytes = (await ranged.arrayBuffer()).byteLength;
  if (ranged.status !== 206 || bytes !== 1024) {
    fail(
      `${which} audio: Range expected 206 with 1024 bytes, got ${ranged.status} with ${bytes}.`
    );
  }
  pass(
    `GET .../demo/audio/${which} Range 0-1023 -> 206, 1024 bytes of ` +
      `${ranged.headers.get("content-range")?.split("/")[1] ?? "?"}`
  );
}

/* 4 — the upload cap, through the proxy ----------------------------------- */

if (password === undefined) {
  out("  skip  26 MiB upload probe (pass --email= and --password= to run it)");
} else {
  const signIn = await fetch(`${base}${config.auth.basePath}/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password }),
  });
  if (!signIn.ok) fail(`Sign-in failed (${signIn.status}): ${await signIn.text()}`);
  const cookie = signIn.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");

  // One MiB over the API's cap: past the cap, well inside Next's raised buffer
  // limit, and under Cloud Run's 32 MiB request ceiling — so the only thing
  // that can refuse it is the API's own multipart limit.
  const size = config.limits.maxUploadBytes + 1024 * 1024;
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(size)], { type: "audio/mpeg" }),
    "big.mp3"
  );

  const upload = await fetch(`${base}/api/v1/localize/jobs`, {
    method: "POST",
    headers: { cookie, origin },
    body: form,
  });
  const body = await upload.text();
  if (upload.status !== 413) {
    fail(
      `A ${(size / 1024 / 1024).toFixed(0)} MiB upload expected 413, got ${upload.status}: ` +
        `${body.slice(0, 300)}\n` +
        "Anything but 413 means the body reached the API truncated — check " +
        "experimental.proxyClientMaxBodySize in web/next.config.ts."
    );
  }
  pass(
    `POST ${(size / 1024 / 1024).toFixed(0)} MiB upload through the web origin -> 413`
  );
}

out();
out("  All checks passed.");
out();
