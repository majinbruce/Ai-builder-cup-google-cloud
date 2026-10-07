import { describe, expect, it } from "vitest";
import {
  buildSegmentInput,
  formatAnalysisForBrief,
} from "../src/modules/localize/adapt.stage.ts";
import {
  buildCritiqueInput,
  formatPairsForCritique,
} from "../src/modules/localize/critique.stage.ts";
import { Analysis } from "../src/modules/localize/localize.schemas.ts";
import type {
  Adaptation,
  AdaptedSegment,
  AnalyzedSegment,
  Speaker,
} from "../src/modules/localize/localize.schemas.ts";
import { castVoices, mainSpeaker, speakerOf } from "../src/modules/localize/speakers.ts";
import {
  buildSpeechDirection,
  groupIntoUtterances,
} from "../src/modules/localize/synthesize.stage.ts";

/**
 * Who is speaking, from the analysis to the voice.
 *
 * The clip behind all of this: a woman presents to camera, asks a man at the
 * whiteboard what he is writing, and he says "I have no idea." It came back as
 * one segment, in one male voice. So what is pinned here is each place that
 * went wrong for it: the cast, the cut at a change of speaker, the grammar note
 * the adapter gets, and what the voice is told when the line is not the
 * teacher's.
 */

const POOLS = { female: ["Kore", "Aoede"], male: ["Charon", "Puck"], fallback: "Charon" };

const woman: Speaker = {
  id: "A",
  voice: "female",
  description: "the presenter, to camera",
};
const lou: Speaker = {
  id: "B",
  voice: "male",
  description: "a colleague at the whiteboard",
};

function source(overrides: Partial<AnalyzedSegment> = {}): AnalyzedSegment {
  return {
    id: "s01",
    startSec: 0,
    endSec: 5,
    text: "Why do B2B videos always have people in a conference room?",
    signal: "example",
    signalConfidence: 0.8,
    signalEvidence: "test",
    register: "humorous",
    pace: "normal",
    emphasis: [],
    idioms: [],
    keyTerms: [],
    ...overrides,
  };
}

function adapted(overrides: Partial<AdaptedSegment> = {}): AdaptedSegment {
  return {
    id: "s01",
    targetText: "बी2बी वीडियो में हमेशा कॉन्फ्रेंस रूम क्यों दिखाते हैं?",
    literalText: "literal",
    termsUsed: [],
    rationale: "kept the joke",
    emphasisTerms: [],
    choices: [],
    ttsHints: { speakingRate: 1, pauseBefore: "none", style: "dry" },
    ...overrides,
  };
}

/** The clip, cut the way the analyze prompt now asks: one segment per speaker. */
const dialogue = {
  speakers: [woman, lou],
  segments: [
    source({ id: "s01", startSec: 0, endSec: 5, speaker: "A" }),
    source({
      id: "s02",
      startSec: 5.2,
      endSec: 6.6,
      speaker: "A",
      text: "Hey Lou, what you writing?",
    }),
    source({
      id: "s03",
      startSec: 6.9,
      endSec: 8,
      speaker: "B",
      text: "I have no idea.",
    }),
    source({
      id: "s04",
      startSec: 8.8,
      endSec: 13,
      speaker: "A",
      text: "Don't make a normal boring corporate video.",
    }),
  ],
};
const byId = new Map(dialogue.segments.map((segment) => [segment.id, segment]));

describe("the Analysis schema", () => {
  it("still parses an analysis with no speakers: every job before 2026-10-07", () => {
    const parsed = Analysis.parse({
      sourceLanguage: "en",
      topic: "t",
      audience: "a",
      segments: [source()],
    });
    expect(parsed.speakers).toBeUndefined();
    expect(parsed.segments[0]?.speaker).toBeUndefined();
  });

  it("carries the speakers and who says each segment", () => {
    const parsed = Analysis.parse({
      sourceLanguage: "en",
      topic: "t",
      audience: "a",
      ...dialogue,
    });
    expect(parsed.speakers).toEqual([woman, lou]);
    expect(parsed.segments.map((segment) => segment.speaker)).toEqual([
      "A",
      "A",
      "B",
      "A",
    ]);
  });
});

describe("speakerOf / mainSpeaker", () => {
  it("resolves a segment's speaker", () => {
    expect(speakerOf(dialogue, dialogue.segments[2] as AnalyzedSegment)).toEqual(lou);
  });

  it("makes no claim when the segment names nobody, or somebody never listed", () => {
    expect(speakerOf(dialogue, source())).toBeUndefined();
    expect(speakerOf(dialogue, source({ speaker: "Z" }))).toBeUndefined();
    expect(speakerOf({}, source({ speaker: "A" }))).toBeUndefined();
  });

  it("takes whoever talks longest as the teacher", () => {
    // The woman has 10.6 s across three segments; Lou has 1.1 s.
    expect(mainSpeaker(dialogue)).toEqual(woman);
    expect(mainSpeaker({ segments: [source()] })).toBeUndefined();
  });
});

describe("castVoices — a voice for each speaker", () => {
  it("gives a woman a woman's voice and a man a man's", () => {
    const cast = castVoices([woman, lou], POOLS);
    expect(cast.get("A")).toBe("Kore");
    expect(cast.get("B")).toBe("Charon");
  });

  it("gives two speakers of the same kind two different voices", () => {
    const cast = castVoices(
      [woman, { id: "B", voice: "female", description: "a student" }],
      POOLS
    );
    expect(cast.get("A")).toBe("Kore");
    expect(cast.get("B")).toBe("Aoede");
  });

  it("casts in the order speakers are first heard, whatever their ids", () => {
    const cast = castVoices(
      [
        { id: "host", voice: "male", description: "the host" },
        { id: "guest", voice: "male", description: "the guest" },
      ],
      POOLS
    );
    expect([cast.get("host"), cast.get("guest")]).toEqual(["Charon", "Puck"]);
  });

  it("uses the default for a voice stage 1 could not place, if nobody has it", () => {
    const unknown: Speaker = { id: "C", voice: "unknown", description: "a crowd" };
    expect(castVoices([unknown], POOLS).get("C")).toBe("Charon");
    // The man already has the default, so the unplaced speaker gets the next
    // unused voice rather than sounding like him.
    expect(castVoices([lou, unknown], POOLS).get("C")).toBe("Puck");
  });

  it("repeats a voice only when its pool has run out", () => {
    const cast = castVoices(
      ["A", "B", "C"].map((id) => ({ id, voice: "male" as const, description: id })),
      POOLS
    );
    expect([...cast.values()]).toEqual(["Charon", "Puck", "Charon"]);
  });

  it("is empty for a job with no speakers, which is then spoken in the default", () => {
    expect(castVoices([], POOLS).size).toBe(0);
  });
});

describe("groupIntoUtterances — one call is one voice", () => {
  it("starts a new utterance when someone else speaks, even mid-sentence", () => {
    const groups = groupIntoUtterances(
      [
        adapted({ id: "s02", targetText: "अरे लू, क्या लिख रहे हो," }),
        adapted({ id: "s03", targetText: "मुझे कोई आइडिया नहीं।" }),
      ],
      byId
    );
    // s02 ends on a comma, which would otherwise join it to s03.
    expect(groups.map((group) => group.segments.map((s) => s.id))).toEqual([
      ["s02"],
      ["s03"],
    ]);
    expect(groups.map((group) => group.speaker)).toEqual(["A", "B"]);
  });

  it("still joins a mid-sentence break when the same person carries on", () => {
    const groups = groupIntoUtterances(
      [
        adapted({ id: "s01", targetText: "बी2बी वीडियो में हमेशा," }),
        adapted({ id: "s02", targetText: "अरे लू, क्या लिख रहे हो?" }),
      ],
      byId
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.speaker).toBe("A");
  });

  it("names no speaker when the analysis does not", () => {
    const plain = new Map([["s01", source()]]);
    expect(groupIntoUtterances([adapted()], plain)[0]?.speaker).toBeUndefined();
  });
});

describe("buildSpeechDirection — when the line is not the teacher's", () => {
  const [utterance] = groupIntoUtterances(
    [adapted({ id: "s03", targetText: "मुझे कोई आइडिया नहीं।" })],
    byId
  );
  const reply = buildSpeechDirection(
    utterance as NonNullable<typeof utterance>,
    byId,
    "A sharp, witty creative strategist",
    1.1,
    undefined,
    lou
  );

  it("says who is speaking instead of the teacher's persona", () => {
    expect(reply).toContain("This is not the teacher speaking");
    expect(reply).toContain("a colleague at the whiteboard");
    expect(reply).not.toContain("A sharp, witty creative strategist");
  });

  it("does not put the house style — which is about the teacher — in their mouth", () => {
    expect(reply).not.toContain("the kind of teacher");
  });

  it("is unchanged for the teacher", () => {
    const teacher = buildSpeechDirection(
      utterance as NonNullable<typeof utterance>,
      byId,
      "A sharp, witty creative strategist",
      1.1
    );
    expect(teacher).toContain("The teacher: A sharp, witty creative strategist");
    expect(teacher).toContain("the kind of teacher");
  });
});

describe("what stage 2 is told about the speaker", () => {
  const brief = {
    topic: "t",
    audience: "a",
    instructorPersona: "p",
    registerGuidance: "r",
    glossary: [],
  };

  it("names the speaker and how their voice sounds, for the grammar", () => {
    const text = buildSegmentInput(
      brief,
      dialogue.segments[0] as AnalyzedSegment,
      [],
      dialogue
    );
    expect(text).toContain("speaker: A — a woman's voice; the presenter, to camera");
  });

  it("says when the line before was someone else's", () => {
    const text = buildSegmentInput(
      brief,
      dialogue.segments[2] as AnalyzedSegment,
      [],
      dialogue
    );
    expect(text).toContain("speaker: B — a man's voice; a colleague at the whiteboard");
    expect(text).toContain("the line before this (s02) was A's");
    expect(text).toContain("This is a different person speaking.");
  });

  it("does not call a continuation by the same speaker a different person", () => {
    const text = buildSegmentInput(
      brief,
      dialogue.segments[1] as AnalyzedSegment,
      [],
      dialogue
    );
    expect(text).not.toContain("different person");
  });

  it("says nothing about speakers when the analysis has none", () => {
    expect(buildSegmentInput(brief, source(), [])).not.toContain("speaker:");
    expect(
      buildSegmentInput(brief, source(), [], { segments: [source()] })
    ).not.toContain("speaker:");
  });

  it("shows the brief who speaks, and tags segments only in a dialogue", () => {
    const text = formatAnalysisForBrief({
      sourceLanguage: "en",
      topic: "t",
      audience: "a",
      ...dialogue,
    });
    expect(text).toContain("## Who speaks");
    expect(text).toContain("- B: a man's voice; a colleague at the whiteboard");
    expect(text).toContain("· speaker B");

    const solo = formatAnalysisForBrief({
      sourceLanguage: "en",
      topic: "t",
      audience: "a",
      speakers: [woman],
      segments: [source({ speaker: "A" })],
    });
    expect(solo).toContain("- A: a woman's voice");
    expect(solo).not.toContain("· speaker A");
  });
});

describe("what the critic is told about the speaker", () => {
  const adaptation = {
    targetLanguage: "hi",
    brief: {
      topic: "t",
      audience: "a",
      instructorPersona: "p",
      registerGuidance: "r",
      glossary: [],
    },
    segments: dialogue.segments.map((segment) => adapted({ id: segment.id })),
  } as Adaptation;
  const analysis = { sourceLanguage: "en", topic: "t", audience: "a", ...dialogue };

  it("gets the voice the Hindi will be heard in, to check its grammar against", () => {
    const pairs = buildCritiqueInput(analysis, adaptation);
    expect(pairs.map((pair) => pair.speakerVoice)).toEqual([
      "female",
      "female",
      "male",
      "female",
    ]);
    const text = formatPairsForCritique(pairs);
    expect(text).toContain("Spoken by: a woman");
    expect(text).toContain("Spoken by: a man");
  });

  it("is told nothing when stage 1 could not tell, rather than a guess", () => {
    const unsure = {
      ...analysis,
      speakers: [{ id: "A", voice: "unknown" as const, description: "a crowd" }, lou],
    };
    const [first] = buildCritiqueInput(unsure, adaptation);
    expect(first?.speakerVoice).toBeUndefined();
    expect(formatPairsForCritique([first as NonNullable<typeof first>])).not.toContain(
      "Spoken by"
    );
  });
});
