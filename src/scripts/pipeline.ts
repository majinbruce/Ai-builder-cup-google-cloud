import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ffmpegAvailable } from "../lib/ffmpeg.ts";
import { TTS_VOICE, listVoices } from "../lib/tts.ts";
import { GEMINI_MODEL, parseThinkingLevel } from "../lib/gemini.ts";
import { runAdapt, runAdaptRetry, runBrief } from "../modules/localize/adapt.stage.ts";
import { runAnalyze } from "../modules/localize/analyze.stage.ts";
import {
  CRITIQUE_THINKING_LEVEL,
  latinScriptViolations,
  runCritique,
  selectForRetry,
} from "../modules/localize/critique.stage.ts";
import { runSynthesize } from "../modules/localize/synthesize.stage.ts";
import { AcousticEvidence, Analysis } from "../modules/localize/localize.schemas.ts";
import type {
  Adaptation,
  ModelCall,
  Synthesis,
} from "../modules/localize/localize.schemas.ts";
import {
  fail,
  out,
  printAdaptedSegment,
  printBrief,
  printCalls,
  printCritiqueSummary,
  printDrift,
  printMeasuredTiming,
  printSegmentCritique,
  printSynthesis,
  readStageOutput,
  writeStageOutput,
} from "./print.ts";

/**
 * ============================================================================
 * The whole pipeline, end to end. The Phase 2 demo.
 * ============================================================================
 *
 *   npm run pipeline                          # all four stages, ending in audio
 *   npm run pipeline -- --no-audio            # stop after critique
 *   npm run pipeline -- --from-analysis       # reuse outputs/analysis.json
 *   npm run pipeline -- --thinking=low
 *   npm run pipeline -- path/to.mp3
 *
 * Since Phase 3 the default is a FULL run ending in outputs/output.mp3.
 * `--no-audio` used to be mandatory, with a hard failure explaining that stage 4
 * did not exist and a note that the day it landed nobody should have to notice
 * the default had silently changed. It landed; the flag is now the opt-out it was
 * always going to become, for iterating on the text stages without paying for
 * synthesis.
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

const thinkingLevel = parseThinkingLevel(args);
const thinking = thinkingLevel === undefined ? {} : { thinkingLevel };

const positional = args.filter((arg) => !arg.startsWith("--"));
const audioPath = path.resolve(positional[0] ?? "fixtures/sample_60s.mp3");

const startedAt = performance.now();
const calls: ModelCall[] = [];

out();
out(
  "  Intent-preserving localization — " +
    (noAudio
      ? "analyze -> adapt -> critique"
      : "analyze -> adapt -> critique -> synthesize")
);
out(`  model     ${GEMINI_MODEL}`);
out(
  `  thinking  ${thinkingLevel ?? `model default, except critique at ${CRITIQUE_THINKING_LEVEL}`}`
);
out(`  target    Hindi (hi)`);
out();

/* -------------------------------------------------------------------------- */
/* Stage 1 — analyze                                                          */
/* -------------------------------------------------------------------------- */

let analysis: Analysis;
// What ffmpeg measured, for stage 4: it places phrases against the teacher's
// pauses. Absent only when an analysis.json from before evidence was saved is reused.
let evidence: AcousticEvidence | undefined;

if (fromAnalysis) {
  const stored = readStageOutput<{ analysis: unknown; evidence?: unknown }>(
    "outputs/analysis.json",
    "npm run stage:analyze"
  );
  analysis = Analysis.parse(stored.analysis);
  evidence = AcousticEvidence.safeParse(stored.evidence).data;
  out(`  [1/4] analyze  SKIPPED — reusing outputs/analysis.json (--from-analysis)`);
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

  out(`  [1/4] analyze  measuring acoustics and calling Gemini with the audio...`);

  const result = await runAnalyze({ audioPath });
  analysis = result.analysis;
  evidence = result.evidence;
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

out("  [2/4] adapt    writing the brief and glossary...");

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

out("  [3/4] critique back-translating and scoring, blind to the reasoning...");

const { critique, call: critiqueCall } = await runCritique({
  analysis,
  adaptation: firstPass,
  ...thinking,
});
calls.push(critiqueCall);

const selected = selectForRetry(critique, firstPass, [], analysis);

let adaptation: Adaptation = firstPass;
let retriedIds: string[] = [];
/**
 * Kept separate from `calls` so adaptation.json can list the calls that
 * produced the text it actually contains.
 *
 * A retry rewrites segments in `adaptation`, so an adaptation.json whose `calls`
 * stopped at the first pass would be a file describing text produced by calls it
 * does not mention — and stage-critique.ts reads that list forward, so the retry
 * telemetry would vanish from the stage-file chain while surviving only in
 * job.json.
 */
let retryCalls: ModelCall[] = [];

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
  retryCalls = retry.calls;
  calls.push(...retryCalls);
} else {
  out("        no segment failed the gate");
}

/* -------------------------------------------------------------------------- */
/* Stage 4 — synthesize                                                       */
/* -------------------------------------------------------------------------- */

let synthesis: Synthesis | null = null;

if (noAudio) {
  out();
  out("  [4/4] synth    SKIPPED (--no-audio)");
} else {
  out();
  out(
    "  [4/4] synth    Chirp 3 HD, one call per sentence group, fitted to the source timeline..."
  );

  if ((await ffmpegAvailable()) === null) {
    fail("ffmpeg is not on PATH, so stage 4 cannot concatenate. sudo apt install ffmpeg");
  }

  // Free and read-only, and it fails before eight paid requests do.
  const voices = await listVoices();
  if (!voices.includes(TTS_VOICE)) {
    fail(`Voice ${TTS_VOICE} is not among the ${voices.length} hi-IN voices available.`);
  }

  const result = await runSynthesize({
    analysis,
    adaptation,
    outDir: "outputs",
    ...(evidence === undefined ? {} : { pauses: evidence.pauses }),
    onProgress: (done, total) => {
      process.stdout.write(`\r        ${done}/${total}          `);
    },
  });

  synthesis = result.synthesis;
  out(`\r        ${synthesis.utterances?.length ?? 0} utterances synthesized      `);
  out(
    `        ${synthesis.durationSec.toFixed(1)}s of Hindi audio, ${synthesis.billedChars} billed chars`
  );
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

if (synthesis !== null) {
  printSynthesis(synthesis);
  printMeasuredTiming(analysis, adaptation, synthesis);
}

printCalls(calls);

out(`  WALL CLOCK, end to end: ${wallClockSec.toFixed(1)}s`);
out(
  `  Demo budget is 2 min for a 60-90s clip (SPEC section g). This run: ` +
    `${wallClockSec < 120 ? "inside it" : "OVER IT"}.`
);
out();

writeStageOutput("adaptation.json", {
  adaptation,
  calls: [briefCall, ...adaptCalls, ...retryCalls],
  retriedIds,
});
writeStageOutput("critique.json", { critique, retriedIds, calls: [critiqueCall] });
if (synthesis !== null) writeStageOutput("synthesis.json", { synthesis });
const jobPath = writeStageOutput("job.json", {
  targetLanguage: adaptation.targetLanguage,
  analysis,
  adaptation,
  critique,
  ...(synthesis === null ? {} : { synthesis }),
  retriedIds,
  calls,
});

out(`  written -> outputs/adaptation.json, outputs/critique.json, ${jobPath}`);
out();
