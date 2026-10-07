import { describe, expect, it } from "vitest";
import {
  ANCHOR_TOLERANCE_SEC,
  anchorSegmentsToPauses,
} from "../src/modules/localize/anchor.ts";
import { charBudget } from "../src/modules/localize/drift.ts";
import type {
  AnalyzedSegment,
  MeasuredPause,
} from "../src/modules/localize/localize.schemas.ts";

/**
 * anchor.ts moves the model's segment edges onto measured pauses, and stage 2's
 * length budget and stage 4's cues are both read off the result. So what is
 * pinned here is what those two stages depend on: which edge of a pause each
 * neighbour gets, and that a cut the measurement cannot vouch for is left alone.
 *
 * The numbers are real where a comment says so: they come from the stored
 * analyses of the fixture clips (docs/research.md, Dub audit).
 */

function segment(
  id: string,
  startSec: number,
  endSec: number,
  text = "one two three four five six seven eight"
): AnalyzedSegment {
  return {
    id,
    startSec,
    endSec,
    text,
    signal: "example",
    signalConfidence: 0.8,
    signalEvidence: "test",
    register: "neutral",
    pace: "normal",
    emphasis: [],
    idioms: [],
    keyTerms: [],
  };
}

const pause = (startSec: number, endSec: number): MeasuredPause => ({
  startSec,
  endSec,
  durationSec: Math.round((endSec - startSec) * 1000) / 1000,
});

describe("anchorSegmentsToPauses", () => {
  it("gives a shared cut to both neighbours as the two edges of the pause", () => {
    // The key-term clip: the model cut at 35.1, 0.3 s into a 1.8 s pause that
    // runs 34.80-36.62. The Hindi for s05 started 1.52 s before the teacher.
    const { segments, anchors } = anchorSegmentsToPauses(
      [segment("s04", 22.8, 35.1), segment("s05", 35.1, 40.2, "remember that word")],
      [pause(34.8, 36.62)]
    );

    expect(segments[0]?.endSec).toBe(34.8);
    expect(segments[1]?.startSec).toBe(36.62);
    expect(anchors).toEqual([
      { segmentId: "s04", edge: "end", modelSec: 35.1, measuredSec: 34.8 },
      { segmentId: "s05", edge: "start", modelSec: 35.1, measuredSec: 36.62 },
    ]);
  });

  it("leaves the teacher's pause between two segments, belonging to neither", () => {
    const { segments } = anchorSegmentsToPauses(
      [segment("s01", 0, 10), segment("s02", 10, 20)],
      [pause(9.6, 10.4)]
    );
    const gap = (segments[1]?.startSec ?? 0) - (segments[0]?.endSec ?? 0);
    expect(gap).toBeCloseTo(0.8, 6);
  });

  it("starts the first segment at the teacher's first word, not at 0", () => {
    // The brachistochrone clip opens on 0.51 s of silence.
    const { segments } = anchorSegmentsToPauses(
      [segment("s01", 0, 9.4)],
      [pause(0, 0.51)]
    );
    expect(segments[0]?.startSec).toBe(0.51);
  });

  it("reads a cut just past a pause as that pause, within the tolerance", () => {
    // One-decimal timestamps: 8.8 for a pause that measured 8.29-8.79.
    const { segments } = anchorSegmentsToPauses(
      [segment("s01", 0, 8.8), segment("s02", 8.8, 13.8)],
      [pause(8.29, 8.79)]
    );
    expect(segments[0]?.endSec).toBe(8.29);
    expect(segments[1]?.startSec).toBe(8.79);
  });

  it("leaves a cut in running speech where the model put it", () => {
    // Speech on both sides: nothing measured says where this thought ends.
    const cut = 13.2;
    const { segments, anchors } = anchorSegmentsToPauses(
      [segment("s02", 8.5, cut), segment("s03", cut, 17)],
      [pause(cut + ANCHOR_TOLERANCE_SEC + 0.05, cut + 1)]
    );
    expect(segments[0]?.endSec).toBe(cut);
    expect(segments[1]?.startSec).toBe(cut);
    expect(anchors).toEqual([]);
  });

  it("does not skip a word spoken before a pause at the top of the clip", () => {
    // "So" at 0.0, then a pause from 0.25: the cue stays on the word.
    const { segments } = anchorSegmentsToPauses(
      [segment("s01", 0, 9)],
      [pause(0.25, 0.7)]
    );
    expect(segments[0]?.startSec).toBe(0);
  });

  it("prefers the pause a cut is inside over a nearer edge of another", () => {
    const { segments } = anchorSegmentsToPauses(
      [segment("s01", 0, 10), segment("s02", 10, 20)],
      [pause(9.7, 9.92), pause(9.98, 10.9)]
    );
    expect(segments[1]?.startSec).toBe(10.9);
    expect(segments[0]?.endSec).toBe(9.98);
  });

  it("refuses an anchor that leaves a span its own words cannot be said in", () => {
    // A quiet question from the room measures as one long "pause": anchoring
    // the segment that IS the question would leave it no time at all.
    const question = segment(
      "s03",
      20,
      25,
      "but why does it not apply to the second case"
    );
    const { segments, anchors } = anchorSegmentsToPauses(
      [segment("s02", 10, 20), question, segment("s04", 25, 33)],
      [pause(19.8, 25.1)]
    );

    expect(segments[1]?.startSec).toBe(20);
    expect(segments[1]?.endSec).toBe(25);
    // Its neighbours are still anchored: the lecturer did stop at 19.8 and did
    // start again at 25.1.
    expect(segments[0]?.endSec).toBe(19.8);
    expect(segments[2]?.startSec).toBe(25.1);
    expect(anchors.map((anchor) => anchor.segmentId)).toEqual(["s02", "s04"]);
  });

  it("keeps the cue when only the end would squeeze the span too far", () => {
    // Start anchors (+0.4 s); the end anchor would leave 0.3 s for eight words.
    const { segments } = anchorSegmentsToPauses(
      [segment("s01", 10, 12)],
      [pause(9.9, 10.4), pause(10.7, 12.1)]
    );
    expect(segments[0]?.startSec).toBe(10.4);
    expect(segments[0]?.endSec).toBe(12);
  });

  it("leaves the end of the last segment alone: nothing follows it", () => {
    // A real clip: the last line runs 13.2-17.0 and the speaker stops at 16.33.
    // Anchoring that end gave the line 3.1 s and a ceiling of 39 characters,
    // when in fact it has until the clip ends.
    const { segments, anchors } = anchorSegmentsToPauses(
      [segment("s03", 8.78, 13.2), segment("s04", 13.2, 17)],
      [pause(16.326, 16.903)]
    );
    expect(segments[1]?.endSec).toBe(17);
    expect(anchors).toEqual([]);
  });

  it("changes nothing when nothing was measured", () => {
    const input = [segment("s01", 0, 10), segment("s02", 10, 20)];
    const { segments, anchors } = anchorSegmentsToPauses(input, []);
    expect(segments).toEqual(input);
    expect(anchors).toEqual([]);
  });

  it("shrinks the length budget to the time the teacher was speaking", () => {
    // What stage 2 is asked to write for: 5.1 s by the model's cuts, 3.58 s of
    // actual speech once the 1.82 s pause is no longer counted as speaking time.
    const model = segment("s05", 35.1, 40.2, "remember that word");
    const { segments } = anchorSegmentsToPauses([model], [pause(34.8, 36.62)]);
    expect(charBudget(model)).toBe(55);
    expect(charBudget(segments[0] as AnalyzedSegment)).toBe(40);
  });
});
