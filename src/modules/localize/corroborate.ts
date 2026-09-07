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
 * 1. **The granularity is the segment, not the word.** Stage 1 returns segment
 *    spans; nothing gives us the timestamp of an individual term. So a claim of
 *    emphasis on "idempotent" is checked against the 4-12 s span containing it.
 *    A supported verdict therefore means "the span carries acoustic evidence
 *    consistent with the claim", not "that word was measurably louder". Word
 *    alignment is the gemini-3.5-transcribe escalation in docs/SPEC.md section
 *    g, and is not pretended at here.
 *
 * 2. **Unsupported does not mean wrong.** Emphasis is realized by pitch,
 *    lengthening and timing as much as by level, and we measure level and
 *    silence. A term stressed by pitch alone will score unsupported. That is
 *    why the rate is reported rather than enforced: it is a floor on
 *    corroboration, not a verdict on the model.
 */

/** A measured pause this close after a span counts as that span's pause. */
const PAUSE_AFTER_TOLERANCE_SEC = 0.4;

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
        checkMarker(segment.id, segment.startSec, segment.endSec, marker, {
          prominentRanges,
          pauses: evidence.pauses,
          windowSec: evidence.windowSec,
        })
      );
    }
  }

  const boundaries = analysis.segments.flatMap((s) => [s.startSec, s.endSec]);
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

  return {
    emphasisChecks,
    supported: emphasisChecks.filter((c) => c.verdict === "supported").length,
    unsupported: emphasisChecks.filter((c) => c.verdict === "unsupported").length,
    notMeasurable: emphasisChecks.filter((c) => c.verdict === "not_measurable").length,
    boundariesAligned,
    boundariesTotal: boundaries.length,
  };
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
