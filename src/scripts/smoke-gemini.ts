import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { GEMINI_MODEL, audioPart, generateJson } from "../lib/gemini.ts";
import { ffmpegAvailable } from "../lib/ffmpeg.ts";
import { loadPrompt } from "../lib/prompts.ts";

/**
 * ============================================================================
 * Phase 0 proof: real audio in, schema-valid JSON out, cost measured.
 * ============================================================================
 *
 *   npm run smoke:gemini                    # fixtures/sample_60s.mp3
 *   npm run smoke:gemini -- path/to.mp3
 *
 * This is not a unit test and deliberately is not one. Everything downstream in
 * docs/SPEC.md rests on a single unverified assumption — that gemini-3.8-flash
 * will accept an audio clip through the Interactions API and return JSON a Zod
 * schema accepts — and that assumption cannot be checked with a mock. So this
 * makes the real call, against the real fixture, and prints what came back.
 *
 * The raw interaction is dumped to outputs/smoke-raw.json because
 * docs/research.md had an open question about where token usage lives on the
 * response. The typings say `usage.total_input_tokens`; this is how we confirm
 * the wire format agrees with them instead of trusting a .d.ts file.
 */

const out = (message: string) => process.stdout.write(`${message}\n`);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * A throwaway shape, not a pipeline schema. Phase 0 proves the plumbing; the
 * pedagogical taxonomy in SPEC section c arrives with the analyze stage.
 *
 * `firstWords` and `notableDelivery` are the two fields that matter. The first
 * is unfakeable without hearing the clip, so it is how we know the audio was
 * actually read. The second probes whether prosody is audible to the model at
 * all — the question the entire differentiator depends on.
 */
const SmokeResult = z.object({
  isSpeech: z.boolean(),
  contentSummary: z.string(),
  firstWords: z.string(),
  durationEstimateSec: z.number().nonnegative(),
  notableDelivery: z.string(),
});

const audioFile = path.resolve(process.argv[2] ?? "fixtures/sample_60s.mp3");

if (!fs.existsSync(audioFile)) {
  fail(
    `No audio at ${audioFile}.\n` +
      "Put a 60-90s English educational clip at fixtures/sample_60s.mp3 " +
      "(see fixtures/README.md), or pass a path: npm run smoke:gemini -- path/to.mp3"
  );
}

const sizeMb = fs.statSync(audioFile).size / 1024 / 1024;

// Reported, not required. The smoke test sends an already-encoded mp3 inline,
// so ffmpeg is not needed here — but it is from Phase 1 onward, and this is the
// checklist item from SPEC section f Phase 0.
const ffmpeg = await ffmpegAvailable();

out("");
out("  Phase 0 smoke test");
out(`  model    ${GEMINI_MODEL}`);
out(`  audio    ${audioFile} (${sizeMb.toFixed(2)} MB)`);
out(`  ffmpeg   ${ffmpeg ?? "NOT ON PATH — required from Phase 1 (apt install ffmpeg)"}`);
out("");

const { data, call, raw } = await generateJson({
  schema: SmokeResult,
  prompt: loadPrompt("smoke.v1"),
  parts: [audioPart(audioFile)],
  stage: "smoke",
});

out("  --- parsed and schema-validated ---");
out(JSON.stringify(data, null, 2));
out("");
out("  --- cost ---");
out(JSON.stringify(call, null, 2));
out("");

fs.mkdirSync("outputs", { recursive: true });
fs.writeFileSync("outputs/smoke-raw.json", JSON.stringify(raw, null, 2));
out("  raw interaction -> outputs/smoke-raw.json");

if (!data.isSpeech) {
  fail(
    "\n  FAILED: the model reports this clip is not speech. The fixture needs a " +
      "real spoken educational excerpt."
  );
}

if (call.inputTokens === 0 || call.outputTokens === 0) {
  fail(
    "\n  FAILED: token usage came back zero, so the telemetry path is wrong. " +
      "Check the `usage` object in outputs/smoke-raw.json against docs/research.md."
  );
}

out("");
out("  PASS: audio was read, JSON matched the Zod schema, usage was reported.");
out("  Check firstWords against the clip yourself — that is the field that");
out("  proves the audio was heard rather than guessed.");
out("");
