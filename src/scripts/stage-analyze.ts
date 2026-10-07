import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { GEMINI_MODEL } from "../lib/gemini.ts";
import { ffmpegAvailable } from "../lib/ffmpeg.ts";
import {
  formatAcousticsForPrompt,
  formatTimestamp,
  measureAcoustics,
} from "../modules/localize/acoustics.ts";
import { runAnalyze } from "../modules/localize/analyze.stage.ts";
import type {
  AnalyzedSegment,
  Corroboration,
} from "../modules/localize/localize.schemas.ts";

/**
 * ============================================================================
 * Stage 1, runnable alone.
 * ============================================================================
 *
 *   npm run stage:analyze                    # fixtures/sample_60s.mp3
 *   npm run stage:analyze -- path/to.mp3
 *   npm run stage:analyze -- --dry-run       # measure only, no Gemini call
 *
 * Writes outputs/analysis.json, which stage-adapt.ts reads. CLAUDE.md requires
 * every stage to run in isolation for a reason that shows up under demo
 * pressure: when the adapt output looks wrong at 2am, the question is whether
 * adapt is wrong or whether it was handed a bad analysis, and that is only
 * answerable if the analysis can be regenerated and read on its own.
 *
 * The corroboration report at the bottom is the honest part. It prints whatever
 * the rate is, including a bad one, and never changes the exit code — see
 * docs/JUDGE_NOTES.md on why a number that can fail a build is a number under
 * pressure to look good.
 */

const out = (message = "") => process.stdout.write(`${message}\n`);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * Measure and print what WOULD be sent, without spending a request.
 *
 * Added the day the free-tier daily cap was hit mid-phase (docs/research.md,
 * "MEASURED 2026-09-07 (second)"). Prompt iteration is mostly a question of
 * whether the acoustic block reads clearly, and answering that by burning one
 * of twenty daily requests is a bad trade. It also means the measurement half
 * of this stage stays demonstrable when the model half is rate-limited.
 */
const dryRun = process.argv.includes("--dry-run");
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

const audioPath = path.resolve(positional[0] ?? "fixtures/sample_60s.mp3");

if (!fs.existsSync(audioPath)) {
  fail(
    `No audio at ${audioPath}.\n` +
      "Put a 60-90s English educational clip at fixtures/sample_60s.mp3 " +
      "(see fixtures/README.md), or pass a path: npm run stage:analyze -- path/to.mp3"
  );
}

// Unlike the Phase 0 smoke test, this stage cannot run without ffmpeg: the
// acoustic evidence is an input to the prompt, not a decoration on the output.
const ffmpegVersion = await ffmpegAvailable();
if (ffmpegVersion === null) {
  fail(
    "ffmpeg is not on PATH. Stage 1 measures pauses and energy with it and feeds " +
      "those measurements into the prompt, so there is no degraded mode here.\n" +
      "Install it: sudo apt install ffmpeg"
  );
}

out();
out("  Stage 1 — analyze");
out(`  model    ${GEMINI_MODEL}`);
out(`  audio    ${audioPath}`);
out(`  ffmpeg   ${ffmpegVersion}`);
out();

if (dryRun) {
  const measured = await measureAcoustics(audioPath);

  out("  --- measured (ffmpeg, no model involved) ---");
  out(
    `  ${measured.durationSec.toFixed(1)}s · mean ${measured.meanVolumeDb.toFixed(1)} dBFS · ` +
      `silence threshold ${measured.silenceThresholdDb} dBFS (mean − ${measured.thresholdOffsetDb})`
  );
  out(
    `  ${measured.pauses.length} pauses · ${measured.windows.length} energy windows · ` +
      `${measured.windows.filter((w) => w.prominent).length} prominent`
  );
  out();
  out("  --- the text part sent to Gemini alongside the audio ---");
  out();
  out(formatAcousticsForPrompt(measured));
  out();
  out("  --dry-run: no request made. Drop the flag to run the model.");
  out();
  process.exit(0);
}

out("  measuring acoustics, then calling Gemini with audio + measurements...");

const { analysis, evidence, corroboration, call } = await runAnalyze({ audioPath });

out();
out("  --- measured (ffmpeg, no model involved) ---");
out(
  `  ${evidence.durationSec.toFixed(1)}s · mean ${evidence.meanVolumeDb.toFixed(1)} dBFS · ` +
    `silence threshold ${evidence.silenceThresholdDb} dBFS (mean − ${evidence.thresholdOffsetDb})`
);
out(
  `  ${evidence.pauses.length} pauses · ${evidence.windows.length} energy windows · ` +
    `${evidence.windows.filter((w) => w.prominent).length} prominent`
);

out();
out("  --- analysis ---");
out(`  topic     ${analysis.topic}`);
out(`  audience  ${analysis.audience}`);
out(`  language  ${analysis.sourceLanguage}`);
out(`  segments  ${analysis.segments.length}`);
for (const speaker of analysis.speakers ?? []) {
  out(`  speaker   ${speaker.id}: ${speaker.voice} voice — ${speaker.description}`);
}
out();

for (const segment of analysis.segments) {
  printSegment(segment);
}

printCorroboration(corroboration);

out();
out("  --- cost ---");
out(
  `  ${call.inputTokens} in · ${call.outputTokens} out · ${call.thoughtTokens} thinking · ` +
    `${(call.latencyMs / 1000).toFixed(1)}s`
);

fs.mkdirSync("outputs", { recursive: true });
const outputPath = path.join("outputs", "analysis.json");
fs.writeFileSync(
  outputPath,
  JSON.stringify({ analysis, evidence, corroboration, calls: [call] }, null, 2)
);

out();
out(`  written -> ${outputPath}`);
out(
  "  Save an accepted run as fixtures/analysis.expected.json to diff future prompt\n" +
    "  changes against it (gitignored — it transcribes third-party audio)."
);
out();

function printSegment(segment: AnalyzedSegment): void {
  const span = `${formatTimestamp(segment.startSec)}-${formatTimestamp(segment.endSec)}`;
  const confidence = segment.signalConfidence.toFixed(2);

  out(
    `  ${segment.id}  ${span.padEnd(13)} ${segment.signal.toUpperCase().padEnd(15)} ` +
      `conf ${confidence}  ${segment.register}/${segment.pace}` +
      (segment.speaker === undefined ? "" : `  speaker ${segment.speaker}`)
  );
  out(`      "${segment.text}"`);
  out(`      why: ${segment.signalEvidence}`);

  for (const marker of segment.emphasis) {
    out(`      emphasis: "${marker.term}" (${marker.strength}) — ${marker.evidence}`);
  }
  for (const idiom of segment.idioms) {
    out(`      ${idiom.kind}: "${idiom.phrase}" — means: ${idiom.intendedMeaning}`);
  }
  if (segment.keyTerms.length > 0) {
    out(`      key terms: ${segment.keyTerms.join(", ")}`);
  }
  out();
}

/**
 * Prints the model's prosody claims next to what was measured.
 *
 * This block is the answer to "how do you know it heard the emphasis rather
 * than guessing it from the meaning", so it prints every claim individually,
 * not just the summary — a rate with no visible misses is a rate nobody can
 * check.
 */
function printCorroboration(report: Corroboration): void {
  const checked = report.emphasisChecks.length;

  out("  --- corroboration: model claims vs ffmpeg measurement ---");
  out();

  if (checked === 0) {
    out("  The model reported no emphasis anywhere in this clip. That is a valid");
    out("  answer for a flat delivery, and a red flag on an animated one — listen");
    out("  to the clip before accepting it.");
    return;
  }

  for (const check of report.emphasisChecks) {
    const mark =
      check.verdict === "supported"
        ? "OK "
        : check.verdict === "unsupported"
          ? "-- "
          : "?? ";
    out(`  ${mark} ${check.segmentId} "${check.term}" (${check.strength})`);
    out(`      model:    ${check.modelEvidence}`);
    out(`      measured: ${check.measurement}`);
  }

  const rate = ((report.supported / checked) * 100).toFixed(0);
  const energyRate = ((report.supportedByEnergy / checked) * 100).toFixed(0);
  const alignRate =
    report.boundariesTotal === 0
      ? "n/a"
      : `${((report.boundariesAligned / report.boundariesTotal) * 100).toFixed(0)}%`;

  out();
  out(
    `  ${report.supported}/${checked} emphasis claims acoustically supported (${rate}%) · ` +
      `${report.unsupported} unsupported · ${report.notMeasurable} not measurable`
  );
  out(
    `  of those, ${report.supportedByEnergy} by a measured energy rise (${energyRate}%) and ` +
      `${report.supportedByPauseOnly} by a closing pause alone`
  );
  out(
    `  ${report.boundariesAligned}/${report.boundariesTotal} interior segment boundaries ` +
      `within 300ms of a measured pause (${alignRate})`
  );

  // Counted above on the model's timestamps; this is what was then done to them.
  const anchors = report.boundaryAnchors ?? [];
  if (anchors.length > 0) {
    const moved = (anchor: (typeof anchors)[number]) =>
      Math.abs(anchor.measuredSec - anchor.modelSec);
    const largest = anchors.reduce((a, b) => (moved(b) > moved(a) ? b : a));
    out(
      `  ${anchors.length} segment edges then moved onto the pause they sat in ` +
        `(largest: ${largest.segmentId} ${largest.edge}, ` +
        `${largest.modelSec.toFixed(1)}s -> ${largest.measuredSec.toFixed(2)}s). ` +
        "The segments above carry the measured edges."
    );
  }
  out();
  out("  Read the energy number, not the headline. A claim also counts as supported");
  out("  when a pause merely closes its span — but the prompt TELLS the model to cut");
  out("  at the measured pauses, so that branch partly rewards instruction-following.");
  out("  Only the energy rise is something the model had to actually locate.");
  out();
  out("  Unsupported is not the same as wrong: this pass measures level and silence,");
  out("  and stress is also carried by pitch and lengthening. The rate is a floor on");
  out("  corroboration, not a score for the model. It never fails the run.");
}
