import { describe, expect, it } from "vitest";
import { escapeConcatPath } from "../src/lib/ffmpeg.ts";
import { MAX_SPEAKING_RATE, MIN_SPEAKING_RATE, clampSpeakingRate } from "../src/lib/tts.ts";
import { MEASURED_CHARS_PER_SEC } from "../src/modules/localize/drift.ts";
import {
  EMPHASIS_PAUSE_MS,
  PAUSE_MS,
  buildTtsInput,
  escapeSsml,
} from "../src/modules/localize/synthesize.stage.ts";
import { SynthesizedSegment } from "../src/modules/localize/localize.schemas.ts";
import type { AdaptedSegment } from "../src/modules/localize/localize.schemas.ts";

/**
 * Stage 4's decisions, provable without a credential, a network or ffmpeg.
 *
 * The split this suite depends on is the one the stage is built around: every
 * choice about WHAT to send lives in buildTtsInput(), which is pure, so the
 * request that reaches Cloud TTS is inspectable by a test. That matters more here
 * than in the earlier stages, because `markupUsed` is shown to a user as a claim
 * about what was applied — and a claim about a request should be checked against
 * the request, not against a description of it.
 *
 * What is deliberately NOT tested here: whether the audio sounds right. That is
 * what src/scripts/spike-tts.ts and a human ear are for, and pretending a unit
 * test could cover it would be the same category error the spike itself made when
 * it read "the duration changed" as "the tag was honoured".
 */

function segment(overrides: Partial<AdaptedSegment> = {}): AdaptedSegment {
  return {
    id: "s01",
    targetText: "यह एक क्लोज़र है और यह ज़रूरी है।",
    literalText: "this is a closure and it is important",
    termsUsed: ["closure"],
    rationale: "kept the definition as a definition",
    emphasisTerms: ["क्लोज़र"],
    choices: [],
    ttsHints: { speakingRate: 1.0, pauseBefore: "none", style: "neutral" },
    ...overrides,
  };
}

describe("escapeSsml", () => {
  it("escapes the five characters that would break an SSML document", () => {
    expect(escapeSsml('a & b < c > d "e"')).toBe(
      "a &amp; b &lt; c &gt; d &quot;e&quot;"
    );
  });

  it("escapes the ampersand first, so an escape is not double-escaped", () => {
    // "&lt;" arriving as literal text must survive as "&amp;lt;", not "&lt;".
    expect(escapeSsml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves Devanagari untouched", () => {
    const hindi = "यह एक क्लोज़र है।";
    expect(escapeSsml(hindi)).toBe(hindi);
  });
});

describe("buildTtsInput — the request that actually goes over the wire", () => {
  it("sends ssml, because that is the only mode <break> works in", () => {
    const built = buildTtsInput(segment());
    expect(built.input.mode).toBe("ssml");
    expect(built.input.content.startsWith("<speak>")).toBe(true);
    expect(built.input.content.endsWith("</speak>")).toBe(true);
  });

  it("never emits inline <prosody> or <emphasis>", () => {
    // The Phase 3 spike measured these ignoring their own rate attribute and
    // inserting ~1.4s of dead time per tag instead: <prosody rate="1.0">, a
    // semantic no-op, moved the duration as much as rate="slow" did. An earlier
    // build wrapped every stressed term and made the fixture 41% long. This test
    // exists so that cannot come back by way of someone reading SPEC section b's
    // conditional without reading docs/research.md's answer to it.
    const built = buildTtsInput(
      segment({ emphasisTerms: ["क्लोज़र", "ज़रूरी"] })
    );
    expect(built.input.content).not.toContain("<prosody");
    expect(built.input.content).not.toContain("<emphasis");
  });

  it("marks exactly one term per segment, however many were requested", () => {
    const built = buildTtsInput(
      segment({ emphasisTerms: ["क्लोज़र", "ज़रूरी", "यह"] })
    );
    const breaks = built.input.content.match(/<break /g) ?? [];
    expect(breaks).toHaveLength(1);
    expect(built.emphasisPausedTerm).toBe("क्लोज़र");
    expect(built.emphasisNotRealized).toEqual(["ज़रूरी", "यह"]);
  });

  it("puts the emphasis break immediately before the term, not after it", () => {
    const built = buildTtsInput(segment());
    expect(built.input.content).toContain(
      `<break time="${EMPHASIS_PAUSE_MS}ms"/>क्लोज़र`
    );
  });

  it("marks only the first occurrence of a term that recurs", () => {
    const built = buildTtsInput(
      segment({ targetText: "क्लोज़र और क्लोज़र", emphasisTerms: ["क्लोज़र"] })
    );
    const breaks = built.input.content.match(/<break /g) ?? [];
    expect(breaks).toHaveLength(1);
  });

  it.each([
    ["none", 0],
    ["short", PAUSE_MS.short],
    ["long", PAUSE_MS.long],
  ] as const)("realizes pauseBefore=%s as %ims", (pauseBefore, expected) => {
    const built = buildTtsInput(
      segment({
        emphasisTerms: [],
        ttsHints: { speakingRate: 1.0, pauseBefore, style: "x" },
      })
    );

    expect(built.pauseBeforeMs).toBe(expected);
    if (expected === 0) {
      expect(built.input.content).not.toContain("<break");
    } else {
      expect(built.input.content).toContain(`<speak><break time="${expected}ms"/>`);
    }
  });

  it("reports pauseBeforeMs separately from the markup", () => {
    // A segment whose first emphasis term opens the sentence produces a <break>
    // in the leading position that is NOT a lead pause. The panel has to tell
    // those apart, and grepping the rendered string cannot.
    const built = buildTtsInput(
      segment({ targetText: "क्लोज़र है।", emphasisTerms: ["क्लोज़र"] })
    );
    expect(built.input.content.startsWith('<speak><break time="150ms"/>')).toBe(true);
    expect(built.pauseBeforeMs).toBe(0);
  });

  it("collects an emphasis term that does not occur in its own targetText", () => {
    const built = buildTtsInput(
      segment({ emphasisTerms: ["इनवेरिएंट", "क्लोज़र"] })
    );
    expect(built.emphasisNotFound).toEqual(["इनवेरिएंट"]);
    // and the one that IS present still gets marked
    expect(built.emphasisPausedTerm).toBe("क्लोज़र");
  });

  it("escapes the Hindi before inserting tags, not after", () => {
    const built = buildTtsInput(
      segment({ targetText: "a < b है", emphasisTerms: [] })
    );
    expect(built.input.content).toBe("<speak>a &lt; b है</speak>");
  });

  it("ignores a whitespace-only emphasis term rather than marking nothing", () => {
    const built = buildTtsInput(segment({ emphasisTerms: ["   ", "क्लोज़र"] }));
    expect(built.emphasisPausedTerm).toBe("क्लोज़र");
  });

  it("passes the segment rate through, clamped to what the API accepts", () => {
    expect(
      buildTtsInput(
        segment({ ttsHints: { speakingRate: 0.92, pauseBefore: "none", style: "x" } })
      ).speakingRate
    ).toBe(0.92);
  });
});

describe("clampSpeakingRate", () => {
  it("clamps to Chirp 3 HD's documented range at both ends", () => {
    expect(clampSpeakingRate(0.1)).toBe(MIN_SPEAKING_RATE);
    expect(clampSpeakingRate(9)).toBe(MAX_SPEAKING_RATE);
    expect(clampSpeakingRate(1.05)).toBe(1.05);
  });
});

describe("escapeConcatPath", () => {
  it("absolutizes, because the demuxer resolves against the LIST file's dir", () => {
    // Measured 2026-09-08: a relative path in a list written to outputs/ made
    // ffmpeg look for outputs/outputs/segments/s01.wav and fail.
    const line = escapeConcatPath("outputs/segments/s01.wav");
    expect(line.startsWith("file '/")).toBe(true);
    expect(line).not.toContain("outputs/outputs");
  });

  it("escapes a single quote so a path cannot end the quoting early", () => {
    const line = escapeConcatPath("/tmp/it's/a.wav");
    expect(line).toBe("file '/tmp/it'\\''s/a.wav'");
  });
});

describe("the Synthesis schema", () => {
  it("requires a measured duration, so an unmeasured segment cannot be stored", () => {
    const base = {
      id: "s01",
      startSec: 0,
      endSec: 4,
      voice: "hi-IN-Chirp3-HD-Kore",
      speakingRate: 1,
      markupUsed: "<speak>यह</speak>",
      inputMode: "ssml",
      billedChars: 20,
      latencyMs: 1200,
      pauseBeforeMs: 0,
      emphasisNotFound: [],
      emphasisPausedTerm: null,
      emphasisNotRealized: [],
    };

    expect(
      SynthesizedSegment.parse({ ...base, measuredDurationSec: 4.2 }).measuredDurationSec
    ).toBe(4.2);
    // Zero is not a duration a real synthesis produces; it is the value a
    // half-written record would carry.
    expect(() => SynthesizedSegment.parse({ ...base, measuredDurationSec: 0 })).toThrow();
  });
});

describe("MEASURED_CHARS_PER_SEC", () => {
  it("is the plain-text rate measured in Phase 3, not the Phase 2 estimate", () => {
    // Guards the specific claim in docs/research.md and docs/JUDGE_NOTES.md: the
    // constant was 13 by arithmetic and is 12.72 by measurement on
    // hi-IN-Chirp3-HD-Kore. If a voice change moves it, the baseline run has to
    // be redone and this number updated with it — the test is here so the docs
    // and the code cannot quietly disagree about which one is live.
    expect(MEASURED_CHARS_PER_SEC).toBeCloseTo(12.72, 2);
  });
});
