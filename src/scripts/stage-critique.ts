import process from "node:process";
import { GEMINI_MODEL, type ThinkingLevel } from "../lib/gemini.ts";
import { runAdaptRetry } from "../modules/localize/adapt.stage.ts";
import {
  buildCritiqueInput,
  formatPairsForCritique,
  runCritique,
  selectForRetry,
} from "../modules/localize/critique.stage.ts";
import { Adaptation, Analysis } from "../modules/localize/localize.schemas.ts";
import type { ModelCall } from "../modules/localize/localize.schemas.ts";
import {
  out,
  printAdaptedSegment,
  printCalls,
  printCritiqueSummary,
  printSegmentCritique,
  readStageOutput,
  writeStageOutput,
} from "./print.ts";

/**
 * ============================================================================
 * Stage 3, runnable alone, including the one-shot retry.
 * ============================================================================
 *
 *   npm run stage:critique
 *   npm run stage:critique -- --dry-run           # print the critic's payload
 *   npm run stage:critique -- --thinking=low      # the SPEC section g lever
 *   npm run stage:critique -- --no-retry          # score only, change nothing
 *
 * Reads outputs/analysis.json and outputs/adaptation.json. Writes
 * outputs/critique.json, and — when the retry runs — an updated
 * outputs/adaptation.json with the regenerated segments substituted in.
 *
 * The dry run prints the exact payload the critic receives. That is worth more
 * here than anywhere else in the pipeline: the blindness claim is a claim about
 * what is in that payload, so being able to read it and confirm that no
 * rationale, brief or glossary appears is how the claim gets checked by a human
 * rather than only by a test.
 */

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noRetry = args.includes("--no-retry");

const thinkingArg = args.find((arg) => arg.startsWith("--thinking="));
const thinkingLevel =
  thinkingArg === undefined ? undefined : (thinkingArg.split("=")[1] as ThinkingLevel);

const analysis = Analysis.parse(
  readStageOutput<{ analysis: unknown }>("outputs/analysis.json", "npm run stage:analyze")
    .analysis
);
const adaptationFile = readStageOutput<{ adaptation: unknown; calls?: ModelCall[] }>(
  "outputs/adaptation.json",
  "npm run stage:adapt"
);
const adaptation = Adaptation.parse(adaptationFile.adaptation);

// Stage 2's own calls, carried forward. Rewriting adaptation.json with only this
// stage's calls would erase the cost of producing the very text the file
// contains, and that per-call telemetry is the evidence for SPEC section e's
// claim that the visible reasoning is worth what it costs.
const adaptCalls = adaptationFile.calls ?? [];

out();
out("  Stage 3 — critique");
out(`  model     ${GEMINI_MODEL}`);
out(`  thinking  ${thinkingLevel ?? "default"}`);
out(`  segments  ${adaptation.segments.length}`);
out();

if (dryRun) {
  out("  --- everything the critic will see ---");
  out();
  out(formatPairsForCritique(buildCritiqueInput(analysis, adaptation)));
  out();
  out("  Note what is NOT above: no rationale, no adaptation choices, no literalText,");
  out("  no brief, no glossary, no TTS hints, and not even the adapter's own list of");
  out("  which Hindi tokens carry the stress. The critic gets the English, the signal");
  out("  label, the terms the SPEAKER stressed, and the Hindi. That is the whole of");
  out("  what 'blind' means here, and this is where you verify it.");
  out();
  out("  --dry-run: no request made.");
  out();
  process.exit(0);
}

out("  back-translating and scoring, blind to the adapter's reasoning...");

const { critique, call: critiqueCall } = await runCritique({
  analysis,
  adaptation,
  ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
});

out();
out("  --- critique ---");
out();

for (const scored of critique.segments) {
  printSegmentCritique(scored);
}

printCritiqueSummary(critique);

const selected = selectForRetry(critique, adaptation);
const calls = [critiqueCall];
let finalAdaptation = adaptation;
let retriedIds: string[] = [];

out("  --- retry gate ---");
out();

if (selected.length === 0) {
  out("  No segment failed the gate. Nothing is re-adapted.");
  out();
} else if (noRetry) {
  out(`  ${selected.length} segment(s) would be re-adapted, but --no-retry was passed:`);
  for (const entry of selected) {
    out(`    ${entry.critique.id}: ${entry.reasons.join("; ")}`);
  }
  out();
} else {
  out(`  ${selected.length} segment(s) go back through Adapt, exactly once:`);
  for (const entry of selected) {
    out(`    ${entry.critique.id}: ${entry.reasons.join("; ")}`);
  }
  out();

  const retry = await runAdaptRetry({
    analysis,
    adaptation,
    critiques: selected.map((entry) => entry.critique),
  });

  finalAdaptation = retry.adaptation;
  retriedIds = retry.retriedIds;
  calls.push(...retry.calls);

  out("  --- regenerated ---");
  out();

  const sourceById = new Map(analysis.segments.map((segment) => [segment.id, segment]));
  for (const id of retriedIds) {
    const before = adaptation.segments.find((segment) => segment.id === id);
    const after = finalAdaptation.segments.find((segment) => segment.id === id);
    if (before === undefined || after === undefined) continue;

    out(`  ${id} BEFORE  ${before.targetText}`);
    out(`  ${id} AFTER   ${after.targetText}`);
    out();
    printAdaptedSegment(sourceById.get(id) as Analysis["segments"][number], after, {
      retried: true,
    });
  }

  out("  The second result is kept regardless of whether it is better, and it is NOT");
  out("  re-scored. A loop that retried until the critic was satisfied would converge");
  out("  on output this critic likes, which — same model family — is a different");
  out("  target from output that teaches. The bound is the honest part.");
  out();
}

printCalls(calls);

const critiquePath = writeStageOutput("critique.json", {
  critique,
  retriedIds,
  calls,
});

if (retriedIds.length > 0) {
  const adaptationPath = writeStageOutput("adaptation.json", {
    adaptation: finalAdaptation,
    calls: [...adaptCalls, ...calls],
    retriedIds,
  });
  out(`  written -> ${adaptationPath} (regenerated segments substituted in)`);
}

out(`  written -> ${critiquePath}`);
out();
