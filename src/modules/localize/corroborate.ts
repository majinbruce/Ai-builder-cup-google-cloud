import { collapseProminentRanges, formatTimestamp } from "./acoustics.ts";
import type {
  AcousticEvidence,
  Analysis,
  Corroboration,
  EmphasisCheck,
} from "./localize.schemas.ts";

/**
 * ============================================================================
 * Scoring the model's prosody claims against the measurements.
 * ============================================================================
 *
 * The pitch says "we detect how the teacher delivered this". The obvious
 * question — how do you know the model heard delivery rather than inferring it
 * from meaning? — has exactly one good answer, which is a number, produced by
 * something other than the model, that says how often its claims line up with
 * what was actually recorded. This module produces that number.
 *
 * Two things it is honest about, because overclaiming here would undo the point
 * of building it:
 *
 * 1. **The granularity is about a second around the word.** Stage 1 gives each
 *    stressed term an `atSec`, and the claim is checked against the energy
 *    windows touching that moment and a pause closing it. It was the whole
 *    4-12 s segment until 2026-10-06, when six new clips scored 54 of 54
 *    claims supported — a check nothing could fail. The timestamp is the
 *    model's own, good to roughly half a second, so the window is 1.5 s wide
 *    and "supported" means "the level rose, or the speaker stopped, where the
 *    model says the word was" — not forced word alignment. A marker without
 *    `atSec` (older stored jobs) is still checked against its segment span.
 *
 * 2. **Unsupported does not mean wrong.** Emphasis is realized by pitch,
 *    lengthening and timing as much as by level, and we measure level and
 *    silence. A term stressed by pitch alone will score unsupported. That is
 *    why the rate is reported rather than enforced: it is a floor on
 *    corroboration, not a verdict on the model.
 */

/** A measured pause this close after a span counts as that span's pause. */
const PAUSE_AFTER_TOLERANCE_SEC = 0.4;

/** Half-width of the span checked around a term's `atSec`. */
const TERM_WINDOW_SEC = 0.75;

/** How near a real pause a segment boundary must land to count as aligned. */
const BOUNDARY_TOLERANCE_SEC = 0.3;

/**
 * Checks every emphasis claim in the analysis and measures boundary alignment.
 *
 * Pure: the same analysis and evidence always give the same report, which is
 * what makes it unit-testable without ffmpeg or a network call.
 */
export function corroborate(
  analysis: Analysis,
  evidence: AcousticEvidence
): Corroboration {
  const prominentRanges = collapseProminentRanges(evidence);
  const emphasisChecks: EmphasisCheck[] = [];

  for (const segment of analysis.segments) {
    for (const marker of segment.emphasis) {
      emphasisChecks.push(
        checkMarker(segment.id, ...checkedSpan(segment, marker.atSec), marker, {
          prominentRanges,
          pauses: evidence.pauses,
          windowSec: evidence.windowSec,
        })
      );
    }
  }

  const boundaries = interiorBoundaries(analysis);
  const boundariesAligned = boundaries.filter((boundary) =>
    evidence.pauses.some(
      (pause) =>
        // Aligned to either edge: a boundary sits at the start of a pause when
        // the segment ends into it, and at the end of one when the next segment
        // begins out of it.
        Math.abs(pause.startSec - boundary) <= BOUNDARY_TOLERANCE_SEC ||
        Math.abs(pause.endSec - boundary) <= BOUNDARY_TOLERANCE_SEC
    )
  ).length;

  const supportedChecks = emphasisChecks.filter((c) => c.verdict === "supported");

  return {
    emphasisChecks,
    supported: supportedChecks.length,
    // The measurement string is written by checkMarker below and is the only
    // record of WHICH branch supported a claim, so it is what distinguishes
    // them here. See the Corroboration schema for why the split matters.
    supportedByEnergy: supportedChecks.filter((c) => c.measurement.startsWith("Energy"))
      .length,
    supportedByPauseOnly: supportedChecks.filter(
      (c) => !c.measurement.startsWith("Energy")
    ).length,
    unsupported: emphasisChecks.filter((c) => c.verdict === "unsupported").length,
    notMeasurable: emphasisChecks.filter((c) => c.verdict === "not_measurable").length,
    boundariesAligned,
    boundariesTotal: boundaries.length,
  };
}

/**
 * The boundaries the model actually chose, each counted once.
 *
 * Segments are contiguous, so segment N's `endSec` and segment N+1's `startSec`
 * are one decision, not two; flattening every span into a start and an end
 * counted each interior cut twice and then added the clip's own 0.0 and its
 * duration, neither of which is a model choice and neither of which can sit
 * near a mid-clip pause. On the first real run that denominator turned 4 of 8
 * genuinely aligned cuts into a reported "8/18 (44%)". Same alignment, worse
 * number, and the wrong question answered.
 */
/**
 * The span a claim is checked against: about a second around the term when the
 * model timed it inside its own segment, the whole segment otherwise. A
 * timestamp outside the segment is the model contradicting itself, and is not
 * trusted over the span it also gave.
 */
function checkedSpan(
  segment: { startSec: number; endSec: number },
  atSec: number | undefined
): [startSec: number, endSec: number] {
  if (atSec === undefined || atSec < segment.startSec || atSec > segment.endSec) {
    return [segment.startSec, segment.endSec];
  }
  return [Math.max(0, atSec - TERM_WINDOW_SEC), atSec + TERM_WINDOW_SEC];
}

function interiorBoundaries(analysis: Analysis): number[] {
  const cuts = new Set<number>();

  for (let index = 1; index < analysis.segments.length; index += 1) {
    const previous = analysis.segments[index - 1];
    const current = analysis.segments[index];
    if (previous === undefined || current === undefined) continue;

    // Usually identical (contiguous segments); the Set collapses them. When the
    // model leaves a gap they are two distinct cuts and both get judged.
    cuts.add(previous.endSec);
    cuts.add(current.startSec);
  }

  return [...cuts];
}

function checkMarker(
  segmentId: string,
  startSec: number,
  endSec: number,
  marker: { term: string; strength: "moderate" | "strong"; evidence: string },
  measured: {
    prominentRanges: Array<{ startSec: number; endSec: number; peakDb: number }>;
    pauses: Array<{ startSec: number; endSec: number; durationSec: number }>;
    windowSec: number;
  }
): EmphasisCheck {
  const base = {
    segmentId,
    term: marker.term,
    strength: marker.strength,
    modelEvidence: marker.evidence,
  };

  // A span shorter than one energy window cannot contain a prominent window, so
  // "no prominence found" would be an artifact of the measurement resolution
  // rather than a finding about the audio. Say that, do not score it.
  if (endSec - startSec < measured.windowSec) {
    return {
      ...base,
      verdict: "not_measurable",
      measurement: `Segment span ${(endSec - startSec).toFixed(2)}s is shorter than the ${measured.windowSec}s energy window.`,
    };
  }

  const overlapping = measured.prominentRanges.filter(
    (range) => range.startSec < endSec && range.endSec > startSec
  );

  const pauseAfter = measured.pauses.find(
    (pause) =>
      pause.startSec >= startSec && pause.startSec <= endSec + PAUSE_AFTER_TOLERANCE_SEC
  );

  if (overlapping.length > 0) {
    const peak = Math.max(...overlapping.map((r) => r.peakDb));
    const where = overlapping
      .map((r) => `${formatTimestamp(r.startSec)}-${formatTimestamp(r.endSec)}`)
      .join(", ");

    return {
      ...base,
      verdict: "supported",
      measurement:
        `Energy rise inside the span at ${where}, peak ${peak.toFixed(1)} dBFS` +
        (pauseAfter === undefined
          ? "."
          : `, followed by a ${pauseAfter.durationSec.toFixed(2)}s pause at ${formatTimestamp(pauseAfter.startSec)}.`),
    };
  }

  if (pauseAfter !== undefined) {
    return {
      ...base,
      verdict: "supported",
      measurement:
        `No energy rise in the span, but a ${pauseAfter.durationSec.toFixed(2)}s pause ` +
        `at ${formatTimestamp(pauseAfter.startSec)} closes it — the "let that land" pattern.`,
    };
  }

  return {
    ...base,
    verdict: "unsupported",
    measurement:
      `No prominent energy window and no closing pause between ` +
      `${formatTimestamp(startSec)} and ${formatTimestamp(endSec)}. The claim may still ` +
      "be right by pitch or lengthening, which this pass does not measure.",
  };
}
