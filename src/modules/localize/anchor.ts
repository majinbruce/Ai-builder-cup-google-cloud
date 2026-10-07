import type {
  AnalyzedSegment,
  BoundaryAnchor,
  MeasuredPause,
} from "./localize.schemas.ts";

/**
 * ============================================================================
 * Segment edges, moved onto the pauses ffmpeg measured.
 * ============================================================================
 *
 * Stage 1 is told where the speaker went quiet and asked to cut there, and it
 * does: on nine clips, 55 of 57 interior cuts sat in a measured pause or within
 * 0.12 s of one (docs/research.md, Dub audit). But a cut is one number and a
 * pause has two edges. The model reports one timestamp somewhere inside the
 * silence and gives it to both neighbours — as the end of one segment and the
 * start of the next.
 *
 * Everything after stage 1 reads those two fields as "when the teacher said
 * this". Stage 4 starts the Hindi at `startSec`: with the cut 0.3 s into a
 * 1.8 s pause before a key term, the Hindi began 1.5 s before the teacher did,
 * over the one silence in the clip that was there to make the listener wait.
 * Stage 2 budgets its Hindi from `endSec - startSec`: with the pause counted
 * as speaking time, the text is written to fill it.
 *
 * So each edge that sits in a measured pause takes that pause's own edge: a
 * segment ENDS where the pause starts and the next one STARTS where it ends.
 * The gap left between them is the teacher's silence, measured, and belongs to
 * neither.
 *
 * Pure arithmetic over two lists, like corroborate.ts and drift.ts, and for
 * the same reason: this is a correction applied to the model's output, so
 * nothing the model could influence has any business in it beyond the numbers
 * being corrected.
 */

/**
 * How far outside a measured pause a cut may be and still be read as meaning
 * that pause.
 *
 * Wide enough for the model's one-decimal timestamps and for every near miss
 * measured on the nine clips (the furthest was 0.12 s past a pause's end);
 * narrow enough that no word fits between the cut and the pause. Deliberately
 * tighter than the 0.3 s corroborate.ts calls "aligned": that is a score, and
 * this moves a cue. A cut with real speech on both sides of it is the model's
 * decision about where a thought ends, and stays where the model put it.
 */
export const ANCHOR_TOLERANCE_SEC = 0.15;

/**
 * Nobody teaches at six words a second. A span that an anchor would leave
 * shorter than its own words need is the sign that the "pause" was quiet
 * speech — a question from the room, a mumbled lead-in — which a level
 * threshold cannot tell from silence.
 */
const MAX_WORDS_PER_SEC = 6;

/** Whatever its word count, a span is not anchored down to less than this. */
const MIN_SPAN_SEC = 0.5;

/** Below this an edge has not moved; it is the pause list's own rounding. */
const MOVED_SEC = 0.01;

/**
 * The measured pause a cut sits in or beside, or undefined.
 *
 * A pause that contains the cut wins; otherwise the one whose nearer edge is
 * closest, within the tolerance.
 */
function pauseAt(
  cutSec: number,
  pauses: readonly MeasuredPause[]
): MeasuredPause | undefined {
  let best: MeasuredPause | undefined;
  let bestDistance = Infinity;

  for (const pause of pauses) {
    const distance =
      cutSec >= pause.startSec && cutSec <= pause.endSec
        ? 0
        : Math.min(Math.abs(cutSec - pause.startSec), Math.abs(cutSec - pause.endSec));
    if (distance <= ANCHOR_TOLERANCE_SEC && distance < bestDistance) {
      best = pause;
      bestDistance = distance;
    }
  }

  return best;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Anchors every segment edge that sits in a measured pause. Pure.
 *
 * Returns the segments with their measured edges and, separately, each edge
 * that moved with the model's value beside it. An edge with no pause near it
 * keeps the model's timestamp: a cut in running speech is the model's call, and
 * there is nothing measured to hold it to.
 *
 * An anchor is refused when it would leave a span its own words could not be
 * said in. Both edges are tried first, then the start alone — the start is the
 * Hindi's cue, and matters more — then the end alone. The end of the LAST
 * segment is never anchored: nothing follows it.
 */
export function anchorSegmentsToPauses(
  segments: readonly AnalyzedSegment[],
  pauses: readonly MeasuredPause[]
): { segments: AnalyzedSegment[]; anchors: BoundaryAnchor[] } {
  const anchors: BoundaryAnchor[] = [];

  const anchored = segments.map((segment, index) => {
    const start = pauseAt(segment.startSec, pauses)?.endSec ?? segment.startSec;
    // The last segment keeps its end. The silence after the final word is
    // nobody's cue, the last line of the Hindi may run into it, and its budget
    // and the retry gate's ceiling are both read off this number: anchored, it
    // said the clip ended 0.67 s before it did (measured on the first clip run
    // with a closing pause in its list).
    const end =
      index === segments.length - 1
        ? segment.endSec
        : (pauseAt(segment.endSec, pauses)?.startSec ?? segment.endSec);

    const shortest = Math.max(MIN_SPAN_SEC, wordCount(segment.text) / MAX_WORDS_PER_SEC);
    const fits = (startSec: number, endSec: number) => endSec - startSec >= shortest;

    const [startSec, endSec] = fits(start, end)
      ? [start, end]
      : fits(start, segment.endSec)
        ? [start, segment.endSec]
        : fits(segment.startSec, end)
          ? [segment.startSec, end]
          : [segment.startSec, segment.endSec];

    if (Math.abs(startSec - segment.startSec) >= MOVED_SEC) {
      anchors.push({
        segmentId: segment.id,
        edge: "start",
        modelSec: segment.startSec,
        measuredSec: startSec,
      });
    }
    if (Math.abs(endSec - segment.endSec) >= MOVED_SEC) {
      anchors.push({
        segmentId: segment.id,
        edge: "end",
        modelSec: segment.endSec,
        measuredSec: endSec,
      });
    }

    return { ...segment, startSec, endSec };
  });

  return { segments: anchored, anchors };
}
