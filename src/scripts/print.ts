import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  MEASURED_CHARS_PER_SEC,
  measureDrift,
  type DriftReport,
} from "../modules/localize/drift.ts";
import { RETRY_THRESHOLD } from "../modules/localize/critique.stage.ts";
import type {
  Adaptation,
  AdaptationBrief,
  AdaptedSegment,
  Analysis,
  Critique,
  ModelCall,
  SegmentCritique,
  Synthesis,
} from "../modules/localize/localize.schemas.ts";

/**
 * ============================================================================
 * Shared terminal reporting for the Phase 2 stage scripts.
 * ============================================================================
 *
 * stage-adapt.ts, stage-critique.ts and pipeline.ts print the same artifacts,
 * and CLAUDE.md requires each stage to be runnable and readable alone. Three
 * copies of this formatting would drift, and the version a demo happened to run
 * would be whichever one was maintained — so there is one.
 *
 * The house style, inherited from stage-analyze.ts: print the misses. A report
 * that only shows what worked is a report nobody can check.
 */

export const out = (message = ""): void => {
  process.stdout.write(`${message}\n`);
};

export function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * Reads a stage artifact written by an earlier script.
 *
 * The error names the command that produces the missing file, because the whole
 * point of splitting the pipeline into re-runnable stages is that recovering
 * from a missing input should not require reading the source.
 */
export function readStageOutput<T>(file: string, producedBy: string): T {
  const resolved = path.resolve(file);

  if (!fs.existsSync(resolved)) {
    fail(`No ${file}. Produce it first:\n  ${producedBy}`);
  }

  return JSON.parse(fs.readFileSync(resolved, "utf8")) as T;
}

export function writeStageOutput(file: string, value: unknown): string {
  fs.mkdirSync("outputs", { recursive: true });
  const target = path.join("outputs", file);
  fs.writeFileSync(target, JSON.stringify(value, null, 2));
  return target;
}

export function printBrief(brief: AdaptationBrief): void {
  out("  --- the brief (stage 2a: written before any segment was adapted) ---");
  out();
  out(`  topic     ${brief.topic}`);
  out(`  audience  ${brief.audience}`);
  out(`  persona   ${brief.instructorPersona}`);
  out(`  register  ${brief.registerGuidance}`);
  out();
  out(`  glossary (${brief.glossary.length} terms fixed for the whole clip)`);

  for (const entry of brief.glossary) {
    out(`    ${entry.english} -> ${entry.targetForm}  [${entry.decision}]`);
    out(`        ${entry.why}`);
  }

  out();
}

/**
 * One adapted segment, with everything needed to argue with it.
 *
 * English, then Hindi, then the literal control, then the reasoning. The literal
 * text is printed unconditionally and next to the real answer on purpose: the
 * product's claim is that a non-literal choice was better, and a reader can only
 * evaluate that claim by seeing what the literal version would have been.
 */
export function printAdaptedSegment(
  source: Analysis["segments"][number],
  adapted: AdaptedSegment,
  options: { retried?: boolean } = {}
): void {
  const badge = options.retried === true ? "  [REGENERATED AFTER CRITIQUE]" : "";

  out(
    `  ${adapted.id}  ${source.signal.toUpperCase()} · ${source.register}/${source.pace}${badge}`
  );
  out(`      EN      ${source.text}`);
  out(`      HI      ${adapted.targetText}`);
  out(`      literal ${adapted.literalText}`);
  out(`      why     ${adapted.rationale}`);

  for (const choice of adapted.choices) {
    out(`      [${choice.kind}] "${choice.original}" -> "${choice.adapted}"`);
    out(`          ${choice.why}`);
  }

  if (adapted.emphasisTerms.length > 0) {
    out(`      stress  ${adapted.emphasisTerms.join(", ")}`);
  }
  if (adapted.termsUsed.length > 0) {
    out(`      terms   ${adapted.termsUsed.join(", ")}`);
  }

  out(
    `      voice   rate ${adapted.ttsHints.speakingRate} · pause-before ` +
      `${adapted.ttsHints.pauseBefore} · ${adapted.ttsHints.style}`
  );
  out();
}

/** One segment's scores, with the evidence that has to back them. */
export function printSegmentCritique(scored: SegmentCritique): void {
  const failed =
    scored.fidelity < RETRY_THRESHOLD ||
    scored.naturalness < RETRY_THRESHOLD ||
    !scored.signalPreserved;

  out(
    `  ${failed ? "!! " : "   "}${scored.id}  fidelity ${String(scored.fidelity).padStart(3)} · ` +
      `naturalness ${String(scored.naturalness).padStart(3)} · ` +
      `signal ${scored.signalPreserved ? "kept" : "LOST"} · ` +
      `emphasis ${scored.emphasisPreserved ? "kept" : "LOST"}`
  );
  out(`      back-translation: ${scored.backTranslation}`);

  for (const quote of scored.translationese) {
    out(`      translationese:   "${quote}"`);
  }
  for (const issue of scored.issues) {
    out(`      issue:            ${issue}`);
  }
  if (scored.suggestion !== undefined) {
    out(`      suggestion:       ${scored.suggestion}`);
  }

  out();
}

export function printCritiqueSummary(critique: Critique): void {
  const scores = critique.segments;
  const belowFidelity = scores.filter((s) => s.fidelity < RETRY_THRESHOLD).length;
  const belowNaturalness = scores.filter((s) => s.naturalness < RETRY_THRESHOLD).length;
  const signalLost = scores.filter((s) => !s.signalPreserved).length;

  out(
    `  overall: fidelity ${critique.overallFidelity} · naturalness ` +
      `${critique.overallNaturalness}  (the model's own judgment of the whole clip, ` +
      "not an average)"
  );
  out(
    `  below the ${RETRY_THRESHOLD} retry threshold: ${belowFidelity} on fidelity, ` +
      `${belowNaturalness} on naturalness, ${signalLost} with the signal lost`
  );
  out();
  out("  This is a BLIND BACK-TRANSLATION CHECK, not an independent review: it is the");
  out("  same model family scoring output it produced. What blinding buys is that the");
  out("  critic never saw the rationale, the brief or the glossary — it read the Hindi");
  out("  cold. Read the back-translations against the Hindi, not the numbers alone.");
  out();
}

/**
 * Estimated duration drift, labelled as estimated everywhere it appears.
 *
 * SPEC section g's open risk. The per-segment lines are only printed for
 * segments outside tolerance, because a full table of in-tolerance rows buries
 * the ones worth looking at.
 */
export function printDrift(analysis: Analysis, adaptation: Adaptation): DriftReport {
  const report = measureDrift(analysis.segments, adaptation.segments);
  const percent = (ratio: number) =>
    `${ratio >= 0 ? "+" : ""}${(ratio * 100).toFixed(0)}%`;

  out("  --- length drift (ESTIMATED — see the note below) ---");
  out();
  out(
    `  source ${report.sourceSec.toFixed(1)}s · estimated Hindi ` +
      `${report.estimatedTargetSec.toFixed(1)}s · ${percent(report.ratio)}`
  );
  out(`  ${report.overToleranceCount}/${report.segments.length} segments outside ±25%:`);

  const outliers = report.segments.filter((segment) => segment.overTolerance);
  if (outliers.length === 0) {
    out("    (none)");
  }
  for (const segment of outliers) {
    out(
      `    ${segment.id}  ${segment.sourceSec.toFixed(1)}s source vs ` +
        `${segment.estimatedTargetSec.toFixed(1)}s estimated (${percent(segment.ratio)}), ` +
        `${segment.chars} chars against a ${segment.budgetChars}-char budget`
    );
  }

  out();
  out("  ESTIMATED, not measured: this divides a character count by an assumed 13");
  out("  Devanagari chars/sec. The real number needs Phase 3 to synthesize the audio");
  out("  and divide its measured duration by the characters that produced it. Quoted");
  out("  as a sanity check on the length budget, never as a finding.");
  out();

  return report;
}

/** Per-call cost, and the totals a demo budget is actually spent against. */
export function printCalls(calls: ModelCall[]): void {
  out("  --- cost ---");
  out();

  for (const call of calls) {
    out(
      `  ${call.stage.padEnd(12)} ${String(call.inputTokens).padStart(6)} in · ` +
        `${String(call.outputTokens).padStart(5)} out · ` +
        `${String(call.thoughtTokens).padStart(6)} thinking · ` +
        `${(call.latencyMs / 1000).toFixed(1)}s`
    );
  }

  const total = (pick: (call: ModelCall) => number) =>
    calls.reduce((sum, call) => sum + pick(call), 0);

  out();
  out(
    `  ${calls.length} calls · ${total((c) => c.inputTokens)} in · ` +
      `${total((c) => c.outputTokens)} out · ${total((c) => c.thoughtTokens)} thinking · ` +
      `${(total((c) => c.latencyMs) / 1000).toFixed(1)}s in the model`
  );
  out();
}

/**
 * Stage 4's report: how each utterance was spoken and where it was placed.
 *
 * The verbatim `markupUsed` is the point. SPEC section d item 6 promises the
 * reasoning panel shows the exact TTS settings applied, and this is the terminal
 * version of that promise — a reader can copy a line out of here into the API
 * explorer and get the same audio back. House style per this file's header:
 * print the misses, which here are emphasis terms absent from their own Hindi,
 * lines that had to be recorded again, and what each take would have left.
 */
export function printSynthesis(synthesis: Synthesis): void {
  const utterances = synthesis.utterances ?? [];
  const sourceSec = synthesis.sourceDurationSec ?? 0;

  out("  --- how each utterance was spoken and placed (measured, not estimated) ---");
  out();
  out("  #   segments        at      slot  teacher     take   placed  pace       tempo");

  for (const utterance of utterances) {
    const slot = utterance.deadlineSec - utterance.sourceStartSec;
    // Read off the two lengths: for a Chirp take `speakingRate` also carries
    // the rate it was synthesized at.
    const tempo = utterance.naturalDurationSec / utterance.measuredDurationSec;
    out(
      `  ${String(utterance.index).padEnd(3)} ${utterance.segmentIds.join("+").padEnd(14)} ` +
        `${`${utterance.outputStartSec.toFixed(1)}s`.padStart(6)} ` +
        `${`${slot.toFixed(1)}s`.padStart(8)} ` +
        `${(utterance.speechSec === undefined ? "—" : `${utterance.speechSec.toFixed(1)}s`).padStart(8)} ` +
        `${`${utterance.naturalDurationSec.toFixed(1)}s`.padStart(8)} ` +
        `${`${utterance.measuredDurationSec.toFixed(1)}s`.padStart(8)}  ` +
        `${(utterance.pace ?? "—").padEnd(10)} ` +
        `${utterance.refit ? `×${tempo.toFixed(2)}` : "—"}`
    );
  }
  out();

  // Every line recorded more than once, with what using each take would have
  // meant: the reason there is a second take, and the reason for the choice.
  const retaken = utterances.filter((utterance) => utterance.takes !== undefined);
  for (const utterance of retaken) {
    out(`  #${utterance.index} was recorded ${utterance.takes?.length} times:`);
    for (const take of utterance.takes ?? []) {
      out(
        `      ${take.kept ? "kept" : "    "}  ${take.pace.padEnd(10)} ` +
          `${`${take.durationSec.toFixed(2)}s`.padStart(7)}  ` +
          (take.lateSec > 0
            ? `next line ${take.lateSec.toFixed(2)}s late`
            : `teacher unheard for ${take.silentSec.toFixed(2)}s`)
      );
    }
  }
  if (retaken.length > 0) out();

  for (const utterance of utterances) {
    out(
      `  #${utterance.index} sent (${utterance.inputMode}, ${utterance.billedChars} billed chars, ` +
        `${utterance.latencyMs} ms${utterance.pauseBeforeMs > 0 ? `, ${utterance.pauseBeforeMs} ms silence before` : ""}):`
    );
    out(`      ${utterance.markupUsed}`);
    out();
  }

  const notFound = synthesis.segments.flatMap((segment) => segment.emphasisNotFound);
  out(
    notFound.length === 0
      ? "  Every emphasis term stage 2 asked for occurs in its own Hindi."
      : `  ${notFound.length} emphasis term(s) do NOT occur in their own segment's Hindi: ` +
          notFound.map((term) => `"${term}"`).join(", ")
  );
  const late = utterances.filter(
    (utterance) => utterance.outputStartSec - utterance.sourceStartSec > 0.05
  );
  out(
    `  ${retaken.length}/${utterances.length} utterances recorded more than once; ` +
      `${utterances.filter((utterance) => utterance.refit).length} re-timed; ` +
      `${late.length} start behind their cue. Output ${synthesis.durationSec.toFixed(1)}s ` +
      `for a ${sourceSec.toFixed(1)}s source.`
  );
  out();
}

/**
 * The measured answer to Phase 2's estimate, printed next to what it replaces.
 *
 * docs/JUDGE_NOTES.md committed to this: MEASURED_CHARS_PER_SEC was a character
 * count divided by an assumed constant, labelled an estimate everywhere it
 * surfaced, and Phase 3 is the only place the real number can exist. Printing
 * both is the only version of this that lets a reader see how good the guess was.
 */
export function printMeasuredTiming(
  analysis: Analysis,
  adaptation: Adaptation,
  synthesis: Synthesis
): void {
  const sourceSec = analysis.segments.reduce(
    (total, segment) => total + (segment.endSec - segment.startSec),
    0
  );
  const spokenSec = (synthesis.utterances ?? []).reduce(
    (total, utterance) => total + utterance.measuredDurationSec,
    0
  );
  const estimated = measureDrift(analysis.segments, adaptation.segments);

  out("  --- length drift: the estimate vs the measurement ---");
  out();
  out(`  source span, summed          ${sourceSec.toFixed(1)}s`);
  out(
    `  projected from text alone    ${estimated.estimatedTargetSec.toFixed(1)}s  ` +
      `(${estimated.ratio >= 0 ? "+" : ""}${(estimated.ratio * 100).toFixed(1)}%, ` +
      `projected at ${MEASURED_CHARS_PER_SEC} chars/sec)`
  );
  out(
    `  MEASURED, as synthesized     ${spokenSec.toFixed(1)}s  ` +
      `(${sourceSec === 0 ? 0 : (((spokenSec - sourceSec) / sourceSec) * 100).toFixed(1)}%, ` +
      `synthesized and ffprobe'd)`
  );
  out(`  concatenated output.mp3      ${synthesis.durationSec.toFixed(1)}s`);
  out();

  const joinDelta = Math.abs(synthesis.durationSec - spokenSec);
  out(
    `  The join added ${joinDelta.toFixed(3)}s over the sum of its parts. ` +
      `${joinDelta < 0.15 ? "Lossless within tolerance" : "LARGER THAN EXPECTED — check the concat"}.`
  );
  out();
  out(
    `  This run spoke ${synthesis.measuredCharsPerSec.toFixed(2)} Devanagari chars/sec WITH our pauses ` +
      `applied, against the ${MEASURED_CHARS_PER_SEC} plain-text rate the budget uses. ` +
      "Run --baseline to measure the plain rate again."
  );
  out();
  out(
    `  synthesis cost: ${synthesis.billedChars} billed characters, voice ${synthesis.voice}.`
  );
  out();
}
