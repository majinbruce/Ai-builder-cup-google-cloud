import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ffmpegAvailable } from "../lib/ffmpeg.ts";
import { GEMINI_MODEL, type ThinkingLevel } from "../lib/gemini.ts";
import { runAdapt, runAdaptRetry, runBrief } from "../modules/localize/adapt.stage.ts";
import { runAnalyze } from "../modules/localize/analyze.stage.ts";
import {
  latinScriptViolations,
  runCritique,
  selectForRetry,
} from "../modules/localize/critique.stage.ts";
import { Analysis } from "../modules/localize/localize.schemas.ts";
import type { Adaptation, ModelCall } from "../modules/localize/localize.schemas.ts";
import {
  fail,
  out,
  printAdaptedSegment,
  printBrief,
  printCalls,
  printCritiqueSummary,
  printDrift,
  printSegmentCritique,
  readStageOutput,
  writeStageOutput,
} from "./print.ts";

/**
 * ============================================================================
 * The whole pipeline, end to end. The Phase 2 demo.
 * ============================================================================
 *
 *   npm run pipeline -- --no-audio            # analyze -> adapt -> critique
 *   npm run pipeline -- --no-audio --from-analysis
 *   npm run pipeline -- --no-audio --thinking=low
 *   npm run pipeline -- --no-audio path/to.mp3
 *
 * --no-audio stops after critique. Stage 4 (Chirp 3 HD synthesis) is Phase 3;
 * until it exists the flag is required rather than assumed, so that the day
 * synthesis lands, nobody has to notice that the default silently changed.
 *
 * --from-analysis reuses outputs/analysis.json instead of re-running the audio
 * call. Phase 1 measured that call at 63-70 s and ~20k thought tokens, which is
 * most of the cost of a run and none of what Phase 2 is iterating on. Skipping
 * it turns a Phase 2 prompt change from a ninety-second wait into a thirty-second
 * one, and the analysis is deterministic input for the stages under test either
 * way.
 */

const args = process.argv.slice(2);
const noAudio = args.includes("--no-audio");
const fromAnalysis = args.includes("--from-analysis");

const thinkingArg = args.find((arg) => arg.startsWith("--thinking="));
const thinkingLevel =
  thinkingArg === undefined ? undefined : (thinkingArg.split("=")[1] as ThinkingLevel);
const thinking = thinkingLevel === undefined ? {} : { thinkingLevel };

const positional = args.filter((arg) => !arg.startsWith("--"));
const audioPath = path.resolve(positional[0] ?? "fixtures/sample_60s.mp3");

if (!noAudio) {
  fail(
    "Stage 4 (Chirp 3 HD synthesis) is Phase 3 and does not exist yet, so a full run\n" +
      "is not possible. Run the three stages that do:\n\n" +
      "  npm run pipeline -- --no-audio\n"
  );
}

const startedAt = performance.now();
const calls: ModelCall[] = [];

out();
out("  Intent-preserving localization — analyze -> adapt -> critique");
out(`  model     ${GEMINI_MODEL}`);
out(`  thinking  ${thinkingLevel ?? "default"}`);
out(`  target    Hindi (hi)`);
out();

/* -------------------------------------------------------------------------- */
/* Stage 1 — analyze                                                          */
/* -------------------------------------------------------------------------- */

let analysis: Analysis;

if (fromAnalysis) {
  analysis = Analysis.parse(
    readStageOutput<{ analysis: unknown }>(
      "outputs/analysis.json",
      "npm run stage:analyze"
    ).analysis
  );
  out(`  [1/3] analyze  SKIPPED — reusing outputs/analysis.json (--from-analysis)`);
  out(`        ${analysis.segments.length} segments, topic: ${analysis.topic}`);
} else {
  if (!fs.existsSync(audioPath)) {
    fail(`No audio at ${audioPath}. See fixtures/README.md.`);
  }
  if ((await ffmpegAvailable()) === null) {
    fail(
      "ffmpeg is not on PATH. Stage 1 feeds measured pauses and energy into the\n" +
        "analyze prompt, so there is no degraded mode. Install it: sudo apt install ffmpeg"
    );
  }

  out(`  [1/3] analyze  measuring acoustics and calling Gemini with the audio...`);

  const result = await runAnalyze({ audioPath });
  analysis = result.analysis;
  calls.push(result.call);

  writeStageOutput("analysis.json", {
    analysis: result.analysis,
    evidence: result.evidence,
    corroboration: result.corroboration,
    calls: [result.call],
  });

  out(
    `        ${analysis.segments.length} segments · ` +
      `${result.corroboration.supportedByEnergy}/${result.corroboration.emphasisChecks.length} ` +
      "emphasis claims backed by a measured energy rise"
  );
  out(`        topic: ${analysis.topic}`);
}

out();

/* -------------------------------------------------------------------------- */
/* Stage 2 — brief, then adapt segment by segment                             */
/* -------------------------------------------------------------------------- */

out("  [2/3] adapt    writing the brief and glossary...");

const { brief, call: briefCall } = await runBrief({ analysis, ...thinking });
calls.push(briefCall);

out(`        ${brief.glossary.length} terms fixed for the whole clip`);
out(`        adapting ${analysis.segments.length} segments in order, one call each...`);

const adaptStartedAt = performance.now();

const { adaptation: firstPass, calls: adaptCalls } = await runAdapt({
  analysis,
  brief,
  ...thinking,
  onSegment: (segment, index, total) => {
    process.stdout.write(`\r        ${index + 1}/${total} ${segment.id}          `);
  },
});
calls.push(...adaptCalls);

const adaptWallClockSec = (performance.now() - adaptStartedAt) / 1000;

out(
  `\r        ${analysis.segments.length} segments adapted in ${adaptWallClockSec.toFixed(1)}s`
);
out();

/* -------------------------------------------------------------------------- */
/* Stage 3 — critique, then the one-shot retry                                */
/* -------------------------------------------------------------------------- */

out("  [3/3] critique back-translating and scoring, blind to the reasoning...");

const { critique, call: critiqueCall } = await runCritique({
  analysis,
  adaptation: firstPass,
  ...thinking,
});
calls.push(critiqueCall);

const selected = selectForRetry(critique, firstPass);

let adaptation: Adaptation = firstPass;
let retriedIds: string[] = [];

if (selected.length > 0) {
  out(`        ${selected.length} segment(s) failed the gate — re-adapting once:`);
  for (const entry of selected) {
    out(`          ${entry.critique.id}: ${entry.reasons.join("; ")}`);
  }

  const retry = await runAdaptRetry({
    analysis,
    adaptation: firstPass,
    critiques: selected.map((entry) => entry.critique),
    ...thinking,
  });

  adaptation = retry.adaptation;
  retriedIds = retry.retriedIds;
  calls.push(...retry.calls);
} else {
  out("        no segment failed the gate");
}

const wallClockSec = (performance.now() - startedAt) / 1000;

/* -------------------------------------------------------------------------- */
/* The report                                                                 */
/* -------------------------------------------------------------------------- */

out();
printBrief(brief);

out("  --- side by side, with the reasoning ---");
out();

const sourceById = new Map(analysis.segments.map((segment) => [segment.id, segment]));
const critiqueById = new Map(critique.segments.map((scored) => [scored.id, scored]));
const retried = new Set(retriedIds);

for (const segment of adaptation.segments) {
  printAdaptedSegment(
    sourceById.get(segment.id) as Analysis["segments"][number],
    segment,
    { retried: retried.has(segment.id) }
  );

  const scored = critiqueById.get(segment.id);
  if (scored !== undefined) {
    printSegmentCritique(scored);
  }
}

printCritiqueSummary(critique);
printDrift(analysis, adaptation);

const violations = latinScriptViolations(adaptation);
out("  --- Devanagari-only check (measured, no model involved) ---");
out();
out(
  violations.length === 0
    ? `  0/${adaptation.segments.length} segments contain Latin script. Clean.`
    : `  ${violations.length} segment(s) still contain Latin script after the retry: ` +
        violations.map((v) => `${v.id} (${v.runs.join(", ")})`).join(", ")
);
out();

printCalls(calls);

out(`  WALL CLOCK, end to end: ${wallClockSec.toFixed(1)}s`);
out(
  `  Demo budget is 2 min for a 60-90s clip (SPEC section g). This run: ` +
    `${wallClockSec < 120 ? "inside it" : "OVER IT"}.`
);
out();

writeStageOutput("adaptation.json", {
  adaptation,
  calls: [briefCall, ...adaptCalls],
  retriedIds,
});
writeStageOutput("critique.json", { critique, retriedIds, calls: [critiqueCall] });
const jobPath = writeStageOutput("job.json", {
  targetLanguage: adaptation.targetLanguage,
  analysis,
  adaptation,
  critique,
  retriedIds,
  calls,
});

out(`  written -> outputs/adaptation.json, outputs/critique.json, ${jobPath}`);
out();
