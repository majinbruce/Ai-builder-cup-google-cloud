import type { AnalyzedSegment, AdaptedSegment } from "./localize.schemas.ts";

/**
 * ============================================================================
 * Length budgets, drift, and the Devanagari-only guard.
 * ============================================================================
 *
 * Pure arithmetic and string work, no model and no I/O, for the same reason
 * corroborate.ts is: these numbers exist to be held up against the model's
 * output, so anything the model could influence has no business in here.
 *
 * docs/SPEC.md section g lists "Hindi runs 15-25% longer than the English, so
 * output.mp3 drifts out of sync with source.mp3" as an open risk to be DECIDED
 * in Phase 2. This module is that decision: Adapt receives a soft per-segment
 * character budget derived from the source span, the prompt is explicit that
 * the budget yields to fidelity, and afterwards the drift is measured and
 * printed — including when it is bad.
 */

/**
 * Devanagari characters per second of speech at Chirp 3 HD `speaking_rate` 1.0.
 *
 * MEASURED 2026-09-08, Phase 3, and no longer an estimate. `npm run
 * stage:synthesize -- --baseline` synthesizes every adapted segment as plain
 * text at rate 1.0 and divides the spoken character count by the ffprobe'd
 * duration: 12.72 chars/sec across the eight fixture segments on
 * hi-IN-Chirp3-HD-Kore.
 *
 * The number this replaced was 13, reached by arithmetic (about 5-6 Hindi
 * syllables per second, a little over two code points per syllable) and
 * labelled an estimate in the schema comment, the CLI, docs/research.md and
 * docs/JUDGE_NOTES.md, with a commitment to measure it the moment real audio
 * existed. The guess was 2% high. That is worth stating plainly in both
 * directions: the estimate deserved its caveats, AND it turned out to be good,
 * so Phase 2's conclusion that the length-drift risk was manageable by asking
 * for a budget rather than by post-hoc rate-fitting survives measurement.
 *
 * It stays a constant because a budget is written BEFORE any audio exists —
 * adapt.v1.md needs a number at prompt time. It is deliberately the PLAIN rate,
 * with no pauses and no rate changes: those are stage 4's deliberate additions
 * and folding them in here would budget the adapter for time the synthesizer
 * spends on purpose. A voice change invalidates it; re-run the baseline.
 */
export const MEASURED_CHARS_PER_SEC = 12.72;

/**
 * How far over budget a segment may run before it is worth mentioning.
 *
 * Deliberately loose. The budget is guidance to the model, and a segment that
 * needed 30% more room to keep a definition intact made the right trade — the
 * whole product is built on meaning outranking length. This threshold marks
 * what a human should look at, not what is wrong.
 */
export const DRIFT_TOLERANCE = 0.25;

/**
 * The soft character budget for one source segment.
 *
 * Rounded to something a prompt can state plainly, because a budget of
 * "142.857 characters" invites the model to treat it as a hard constraint to be
 * satisfied exactly, which is the failure mode this is trying to avoid.
 */
export function charBudget(
  segment: Pick<AnalyzedSegment, "startSec" | "endSec">
): number {
  const spanSec = Math.max(0, segment.endSec - segment.startSec);
  return Math.round((spanSec * MEASURED_CHARS_PER_SEC) / 5) * 5;
}

/** One segment's estimated timing against the span it has to fill. */
export interface SegmentDrift {
  id: string;
  sourceSec: number;
  chars: number;
  budgetChars: number;
  /** chars / MEASURED_CHARS_PER_SEC — a projection from a measured rate. */
  estimatedTargetSec: number;
  /** (estimated - source) / source. Positive means the Hindi runs long. */
  ratio: number;
  overTolerance: boolean;
}

export interface DriftReport {
  segments: SegmentDrift[];
  sourceSec: number;
  estimatedTargetSec: number;
  /** Whole-clip drift, the number SPEC section g's risk row is about. */
  ratio: number;
  overToleranceCount: number;
}

/**
 * Estimated drift, per segment and overall.
 *
 * Adapted segments are matched to source segments by id. A source segment with
 * no adapted counterpart is skipped rather than counted as zero-length: the
 * adapt stage already fails loudly on a missing id, and silently averaging a
 * gap into a quality number is how a metric starts lying.
 */
export function measureDrift(
  source: Pick<AnalyzedSegment, "id" | "startSec" | "endSec">[],
  adapted: Pick<AdaptedSegment, "id" | "targetText">[]
): DriftReport {
  const byId = new Map(adapted.map((segment) => [segment.id, segment]));
  const segments: SegmentDrift[] = [];

  for (const sourceSegment of source) {
    const match = byId.get(sourceSegment.id);
    if (match === undefined) continue;

    const sourceSec = Math.max(0, sourceSegment.endSec - sourceSegment.startSec);
    const chars = countSpokenChars(match.targetText);
    const estimatedTargetSec = chars / MEASURED_CHARS_PER_SEC;
    const ratio = sourceSec === 0 ? 0 : (estimatedTargetSec - sourceSec) / sourceSec;

    segments.push({
      id: sourceSegment.id,
      sourceSec,
      chars,
      budgetChars: charBudget(sourceSegment),
      estimatedTargetSec,
      ratio,
      overTolerance: Math.abs(ratio) > DRIFT_TOLERANCE,
    });
  }

  const sourceSec = segments.reduce((total, segment) => total + segment.sourceSec, 0);
  const estimatedTargetSec = segments.reduce(
    (total, segment) => total + segment.estimatedTargetSec,
    0
  );

  return {
    segments,
    sourceSec,
    estimatedTargetSec,
    ratio: sourceSec === 0 ? 0 : (estimatedTargetSec - sourceSec) / sourceSec,
    overToleranceCount: segments.filter((segment) => segment.overTolerance).length,
  };
}

/**
 * Characters that take time to say.
 *
 * Whitespace is excluded because a pause between words is already accounted for
 * by the rate; punctuation is excluded because "।" is not a syllable. Counting
 * them would make the estimate track formatting rather than speech.
 */
export function countSpokenChars(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

/** A stretch of Latin script found where only Devanagari belongs. */
export interface LatinRun {
  text: string;
  index: number;
}

/**
 * Latin-script runs in a string that is supposed to be Devanagari only.
 *
 * `AdaptedSegment.targetText` goes straight to Chirp 3 HD on `hi-IN`, where
 * embedded Latin script is an unverified pronunciation risk (docs/SPEC.md
 * section b) — "closure" left in the middle of a Hindi sentence may be read in
 * an English voice, spelled out, or skipped, and which of those happens is not
 * something this project has measured. So the constraint is enforced rather
 * than requested.
 *
 * Enforced HERE and not as a schema regex, deliberately. A `.regex()` on
 * targetText makes one stray English word fail the Zod parse, which discards a
 * paid call and returns an error the pipeline cannot act on. Detecting it after
 * the parse lets the offending segment join the segments the critique already
 * flagged and go back through the same bounded, one-shot retry.
 *
 * Digits, punctuation and whitespace are allowed: "2026" and "—" carry no
 * script and Chirp reads them in the voice's own language.
 */
export function findLatinRuns(text: string): LatinRun[] {
  const runs: LatinRun[] = [];
  const pattern = /[A-Za-z]+/g;

  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    runs.push({ text: match[0], index: match.index });
    match = pattern.exec(text);
  }

  return runs;
}
