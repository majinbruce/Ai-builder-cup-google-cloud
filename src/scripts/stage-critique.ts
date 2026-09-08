import process from "node:process";
import { GEMINI_MODEL, parseThinkingLevel } from "../lib/gemini.ts";
import { runAdaptRetry } from "../modules/localize/adapt.stage.ts";
import {
  buildCritiqueInput,
  CRITIQUE_THINKING_LEVEL,
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

const thinkingLevel = parseThinkingLevel(args);

const analysis = Analysis.parse(
  readStageOutput<{ analysis: unknown }>("outputs/analysis.json", "npm run stage:analyze")
    .analysis
);
const adaptationFile = readStageOutput<{
  adaptation: unknown;
  calls?: ModelCall[];
  retriedIds?: string[];
}>("outputs/adaptation.json", "npm run stage:adapt");
const adaptation = Adaptation.parse(adaptationFile.adaptation);

/**
 * Segments a PREVIOUS run of this script already sent back through Adapt.
 *
 * This is what makes the bound in SPEC section b survive a second invocation.
 * `selectForRetry` takes an `alreadyRetried` argument for exactly this, but the
 * ids only reach it if they are read back off disk: run `npm run stage:critique`
 * twice and, without this, a segment that fails twice is re-adapted twice, which
 * is a loop with extra steps and precisely the thing "exactly once" rules out.
 * The pipeline never hit it because it critiques once per process; this script
 * is the one place the bound is breakable, so it is the one place it is enforced.
 */
const alreadyRetried = adaptationFile.retriedIds ?? [];

// Stage 2's own calls, carried forward. Rewriting adaptation.json with only this
// stage's calls would erase the cost of producing the very text the file
// contains, and that per-call telemetry is the evidence for SPEC section e's
// claim that the visible reasoning is worth what it costs.
const adaptCalls = adaptationFile.calls ?? [];

out();
out("  Stage 3 — critique");
out(`  model     ${GEMINI_MODEL}`);
out(
  `  thinking  ${thinkingLevel ?? CRITIQUE_THINKING_LEVEL}` +
    `${thinkingLevel === undefined ? " (this stage's measured default)" : " (--thinking)"}`
);
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

const selected = selectForRetry(critique, adaptation, alreadyRetried);
const calls = [critiqueCall];
let finalAdaptation = adaptation;
let retryCalls: ModelCall[] = [];
let retriedIds: string[] = [...alreadyRetried];

out("  --- retry gate ---");
out();

if (alreadyRetried.length > 0) {
  out(
    `  ${alreadyRetried.length} segment(s) were already re-adapted by an earlier run ` +
      `(${alreadyRetried.join(", ")}) and are held out of the gate.`
  );
  out("  SPEC section b: failing segments go back through Adapt exactly once.");
  out();
}

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
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  });

  finalAdaptation = retry.adaptation;
  retryCalls = retry.calls;
  // Appended, not replaced. This list is what a LATER run reads back to hold
  // these segments out of its own gate, so it has to carry every id ever
  // retried for this adaptation — not just the ones this invocation touched.
  retriedIds = [...alreadyRetried, ...retry.retriedIds];
  calls.push(...retryCalls);

  out("  --- regenerated ---");
  out();

  const sourceById = new Map(analysis.segments.map((segment) => [segment.id, segment]));
  for (const id of retry.retriedIds) {
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

if (retryCalls.length > 0) {
  const adaptationPath = writeStageOutput("adaptation.json", {
    adaptation: finalAdaptation,
    // Stage 2's calls plus the retry's, and NOT the critique call. The critique
    // is already recorded in critique.json above, and a reader summing the two
    // files to get a job's cost would otherwise count it twice. Each artifact
    // lists the calls that produced the text IT contains.
    calls: [...adaptCalls, ...retryCalls],
    retriedIds,
  });
  out(`  written -> ${adaptationPath} (regenerated segments substituted in)`);
}

out(`  written -> ${critiquePath}`);
out();
