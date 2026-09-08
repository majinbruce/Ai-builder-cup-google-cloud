import process from "node:process";
import { GEMINI_MODEL } from "../lib/gemini.ts";
import {
  buildSegmentInput,
  formatAnalysisForBrief,
  runAdapt,
  runBrief,
} from "../modules/localize/adapt.stage.ts";
import { latinScriptViolations } from "../modules/localize/critique.stage.ts";
import { Analysis } from "../modules/localize/localize.schemas.ts";
import type { Adaptation } from "../modules/localize/localize.schemas.ts";
import {
  out,
  printAdaptedSegment,
  printBrief,
  printCalls,
  printDrift,
  readStageOutput,
  writeStageOutput,
} from "./print.ts";

/**
 * ============================================================================
 * Stage 2, runnable alone.
 * ============================================================================
 *
 *   npm run stage:adapt                 # reads outputs/analysis.json
 *   npm run stage:adapt -- --dry-run    # print every prompt, spend nothing
 *
 * Writes outputs/adaptation.json, which stage-critique.ts reads.
 *
 * --dry-run matters more here than it did on stage 1. This stage makes one call
 * per segment, so a 12-segment clip is 13 requests, and iterating the wording of
 * adapt.v1.md by spending 13 requests to find out whether the glossary block
 * reads clearly is a bad trade. The dry run prints the exact text that would be
 * sent for every segment, assembled by the same pure functions the real path
 * uses — so what you read is what would be sent, not an approximation of it.
 */

const dryRun = process.argv.includes("--dry-run");

const { analysis } = readStageOutput<{ analysis: unknown }>(
  "outputs/analysis.json",
  "npm run stage:analyze"
);

// Parsed, not cast. The file on disk may have been written by an older schema,
// and a stage that starts from a shape it never checked produces a failure
// twelve calls later that looks like a model problem.
const parsed = Analysis.parse(analysis);

out();
out("  Stage 2 — adapt");
out(`  model     ${GEMINI_MODEL}`);
out(`  segments  ${parsed.segments.length}`);
out(`  target    Hindi (hi)`);
out();

if (dryRun) {
  out("  --- 2a: the text that would be sent for the brief ---");
  out();
  out(formatAnalysisForBrief(parsed));
  out();
  out("  --- 2b: the text that would be sent for the FIRST segment ---");
  out();
  out("  (Later segments additionally carry every previously adapted segment, which");
  out("  does not exist yet on a dry run. The brief below is a placeholder for the");
  out("  same reason — 2a has not run.)");
  out();
  out(
    buildSegmentInput(
      {
        topic: "(the brief has not been generated on a dry run)",
        audience: "(dry run)",
        instructorPersona: "(dry run)",
        registerGuidance: "(dry run)",
        glossary: [],
      },
      parsed.segments[0] as Analysis["segments"][number],
      []
    )
  );
  out();
  out(
    `  --dry-run: no requests made. A real run costs ${parsed.segments.length + 1} calls ` +
      "(1 brief + 1 per segment)."
  );
  out();
  process.exit(0);
}

out("  2a: writing the brief and glossary over the whole analysis...");

const { brief, call: briefCall } = await runBrief({ analysis: parsed });

out();
printBrief(brief);

out(`  2b: adapting ${parsed.segments.length} segments in order, one call each...`);
out();

const startedAt = performance.now();

const { adaptation, calls: adaptCalls } = await runAdapt({
  analysis: parsed,
  brief,
  onSegment: (segment, index, total) => {
    process.stdout.write(`\r  ${index + 1}/${total} ${segment.id} done          `);
  },
});

const wallClockSec = (performance.now() - startedAt) / 1000;

out();
out();
out("  --- adapted segments ---");
out();

const sourceById = new Map(parsed.segments.map((segment) => [segment.id, segment]));
for (const segment of adaptation.segments) {
  printAdaptedSegment(
    sourceById.get(segment.id) as Analysis["segments"][number],
    segment
  );
}

printDrift(parsed, adaptation);
reportLatinScript(adaptation);

const calls = [briefCall, ...adaptCalls];
printCalls(calls);
out(`  wall clock for stage 2b: ${wallClockSec.toFixed(1)}s`);

const written = writeStageOutput("adaptation.json", { adaptation, calls });

out();
out(`  written -> ${written}`);
out("  next: npm run stage:critique");
out();

/**
 * Reports Latin script in the strings destined for a Hindi TTS voice.
 *
 * Printed even when the count is zero, because a zero here is evidence that the
 * Devanagari-only rule in adapt.v1.md is being followed rather than merely
 * stated — and because a rule whose compliance is never displayed is a rule
 * nobody notices has stopped working.
 */
function reportLatinScript(result: Adaptation): void {
  const violations = latinScriptViolations(result);

  out("  --- Devanagari-only check (measured, no model involved) ---");
  out();

  if (violations.length === 0) {
    out(`  0/${result.segments.length} segments contain Latin script. Clean.`);
  } else {
    out(
      `  ${violations.length}/${result.segments.length} segments contain Latin script, ` +
        "which is a pronunciation risk on hi-IN and sends them back through the retry:"
    );
    for (const violation of violations) {
      out(`    ${violation.id}: ${violation.runs.map((run) => `"${run}"`).join(", ")}`);
    }
  }

  out();
}
