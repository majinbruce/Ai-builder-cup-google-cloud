import { describe, expect, it } from "vitest";
import { escapeConcatPath, parseHasPlayableVideo } from "../src/lib/ffmpeg.ts";
import { MAX_SPEAKING_RATE, MIN_SPEAKING_RATE, clampSpeakingRate } from "../src/lib/tts.ts";
import { MEASURED_CHARS_PER_SEC } from "../src/modules/localize/drift.ts";
import { readPcmFormat, silenceWav } from "../src/lib/wav.ts";
import {
  MAX_FIT_SPEEDUP,
  MAX_UTTERANCE_BYTES,
  PAUSE_MS,
  endsSentence,
  groupIntoUtterances,
  placeOnTimeline,
  planFit,
  type TimelineSlot,
} from "../src/modules/localize/synthesize.stage.ts";
import {
  Synthesis,
  SynthesizedSegment,
} from "../src/modules/localize/localize.schemas.ts";
import type {
  AdaptedSegment,
  AnalyzedSegment,
} from "../src/modules/localize/localize.schemas.ts";

/**
 * Stage 4's decisions, provable without a credential, a network or ffmpeg.
 *
 * The split this suite depends on is the one the stage is built around: every
 * choice about WHAT to send and WHERE it goes lives in pure functions
 * (groupIntoUtterances, planFit, placeOnTimeline), so the request that reaches
 * Cloud TTS and the timeline it lands on are inspectable by a test. That matters more here
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

/** Only the fields groupIntoUtterances reads. */
function sources(spans: [string, number, number][]): Map<string, AnalyzedSegment> {
  return new Map(
    spans.map(([id, startSec, endSec]) => [id, { id, startSec, endSec } as AnalyzedSegment])
  );
}

describe("endsSentence", () => {
  it("recognises the danda, question and exclamation marks, and a full stop", () => {
    for (const text of ["यह है।", "क्या होगा?", "वाह!", "That is it.", "॥"]) {
      expect(endsSentence(text)).toBe(true);
    }
  });

  it("looks past closing quotes and trailing space", () => {
    expect(endsSentence("उसने कहा, “रुको।” ")).toBe(true);
  });

  it("does not treat a comma or a dash as an ending", () => {
    // The demo's s02 ended "…एक्सेलरेट करती है," — spoken alone, that comma got
    // a full stop's falling ending, which is the bug this grouping exists for.
    expect(endsSentence("ग्रैविटी आपको एक्सेलरेट करती है,")).toBe(false);
    expect(endsSentence("जो ठीक नीचे न हो—")).toBe(false);
  });
});

describe("groupIntoUtterances — the units actually spoken", () => {
  const map = sources([
    ["s01", 0, 10],
    ["s02", 10, 18],
    ["s03", 18, 31],
    ["s04", 31, 38],
  ]);

  it("joins a segment that ends mid-sentence to the next, so the voice never restarts mid-sentence", () => {
    const groups = groupIntoUtterances(
      [
        segment({ id: "s01", targetText: "पहला वाक्य।" }),
        segment({ id: "s02", targetText: "दूसरा शुरू होता है," }),
        segment({ id: "s03", targetText: "और यहाँ खत्म होता है।" }),
        segment({ id: "s04", targetText: "चौथा?" }),
      ],
      map
    );
    expect(groups.map((group) => group.segments.map((s) => s.id))).toEqual([
      ["s01"],
      ["s02", "s03"],
      ["s04"],
    ]);
    expect(groups[1]?.text).toBe("दूसरा शुरू होता है, और यहाँ खत्म होता है।");
    expect(groups[1]?.sourceStartSec).toBe(10);
  });

  it("starts a new utterance at a requested pause, so the pause is silence between calls", () => {
    const groups = groupIntoUtterances(
      [
        segment({ id: "s01", targetText: "शुरू होता है," }),
        segment({
          id: "s02",
          targetText: "और ध्यान दीजिए।",
          ttsHints: { speakingRate: 1, pauseBefore: "long", style: "x" },
        }),
      ],
      map
    );
    expect(groups).toHaveLength(2);
    expect(groups[1]?.pauseBeforeMs).toBe(PAUSE_MS.long);
  });

  it("never sends inline markup: the request is the Hindi, space-joined", () => {
    const groups = groupIntoUtterances(
      [segment({ id: "s01", targetText: "a < b और c & d है।", emphasisTerms: ["c"] })],
      map
    );
    expect(groups[0]?.text).toBe("a < b और c & d है।");
    expect(groups[0]?.text).not.toContain("<break");
  });

  it("weights the requested rate by each segment's source span", () => {
    const groups = groupIntoUtterances(
      [
        segment({
          id: "s01",
          targetText: "धीमी परिभाषा,",
          ttsHints: { speakingRate: 0.8, pauseBefore: "none", style: "x" },
        }),
        segment({
          id: "s02",
          targetText: "तेज़ बात।",
          ttsHints: { speakingRate: 1.2, pauseBefore: "none", style: "x" },
        }),
      ],
      map
    );
    // (0.8 × 10 + 1.2 × 8) / 18
    expect(groups[0]?.requestedRate).toBeCloseTo(0.978, 3);
  });

  it("splits before the TTS input limit, even mid-sentence", () => {
    // ~1,350 bytes each: three fit under the ceiling, four would not.
    const long = "क".repeat(450) + ",";
    const groups = groupIntoUtterances(
      ["s01", "s02", "s03", "s04"].map((id) => segment({ id, targetText: long })),
      map
    );
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(Buffer.byteLength(group.text, "utf8")).toBeLessThanOrEqual(MAX_UTTERANCE_BYTES);
    }
  });
});

describe("placeOnTimeline — where each utterance lands in the output", () => {
  const slot = (overrides: Partial<TimelineSlot>): TimelineSlot => ({
    sourceStartSec: 0,
    deadlineSec: 10,
    pauseBeforeMs: 0,
    durationSec: 5,
    ...overrides,
  });

  it("starts each utterance at its source start, never earlier", () => {
    const placed = placeOnTimeline([
      slot({ sourceStartSec: 0, durationSec: 4 }),
      slot({ sourceStartSec: 10, durationSec: 3 }),
    ]);
    expect(placed.startSec).toEqual([0, 10]);
    expect(placed.endSec).toBe(13);
  });

  it("pushes an utterance back when the previous one ran long", () => {
    const placed = placeOnTimeline([
      slot({ sourceStartSec: 0, durationSec: 12 }),
      slot({ sourceStartSec: 10, durationSec: 3 }),
    ]);
    expect(placed.startSec).toEqual([0, 12]);
  });

  it("keeps a requested pause even when the gap is too short for it", () => {
    const placed = placeOnTimeline([
      slot({ sourceStartSec: 0, durationSec: 9.8 }),
      slot({ sourceStartSec: 10, pauseBeforeMs: 700, durationSec: 3 }),
    ]);
    expect(placed.startSec[1]).toBeCloseTo(10.5, 6);
  });
});

describe("planFit — which utterances get a faster re-take", () => {
  it("leaves an utterance that fits alone", () => {
    expect(planFit([{ sourceStartSec: 0, deadlineSec: 10, pauseBeforeMs: 0, durationSec: 9.5 }], [1])).toEqual([null]);
  });

  it("ignores an overrun inside the noise tolerance", () => {
    expect(planFit([{ sourceStartSec: 0, deadlineSec: 10, pauseBeforeMs: 0, durationSec: 10.1 }], [1])).toEqual([null]);
  });

  it("speeds an overrunning utterance up to land just inside its deadline", () => {
    // The demo's s01: 12.19 s of Hindi for 10.2 s of English, at rate 1.
    const [rate] = planFit(
      [{ sourceStartSec: 0, deadlineSec: 10.2, pauseBeforeMs: 0, durationSec: 11.0 }],
      [1]
    );
    expect(rate).not.toBeNull();
    expect(11.0 / (rate as number)).toBeLessThan(10.2);
  });

  it("caps the speed-up, so a learner hears brisk rather than rushed", () => {
    const [rate] = planFit(
      [{ sourceStartSec: 0, deadlineSec: 5, pauseBeforeMs: 0, durationSec: 10 }],
      [0.9]
    );
    expect(rate).toBeCloseTo(0.9 * MAX_FIT_SPEEDUP, 3);
  });

  it("counts a refit's expected length forward, not its first take", () => {
    // Without the carry-forward, s2 would be judged as starting at 11 s and refit too.
    const rates = planFit(
      [
        { sourceStartSec: 0, deadlineSec: 10, pauseBeforeMs: 0, durationSec: 11 },
        { sourceStartSec: 10, deadlineSec: 20, pauseBeforeMs: 0, durationSec: 9.8 },
      ],
      [1, 1]
    );
    expect(rates[0]).not.toBeNull();
    expect(rates[1]).toBeNull();
  });
});

describe("parseHasPlayableVideo — which uploads become video jobs", () => {
  it("accepts real footage in the codecs browsers play", () => {
    expect(parseHasPlayableVideo("h264,0\n")).toBe(true);
    expect(parseHasPlayableVideo("hevc,0\n")).toBe(true);
  });

  it("treats an audio file's cover art as no video", () => {
    // ffprobe reports an mp3's embedded artwork as a video stream.
    expect(parseHasPlayableVideo("mjpeg,1\n")).toBe(false);
    expect(parseHasPlayableVideo("png,1\n")).toBe(false);
  });

  it("treats a codec browsers cannot play as no video", () => {
    expect(parseHasPlayableVideo("mpeg2video,0\n")).toBe(false);
  });

  it("treats no video stream as no video", () => {
    expect(parseHasPlayableVideo("")).toBe(false);
  });
});

describe("silenceWav", () => {
  it("mirrors the format it is given, so the concat demuxer can copy without re-encoding", () => {
    const format = { sampleRate: 24000, channels: 1, bitsPerSample: 16 };
    const wav = silenceWav(0.5, format);
    expect(readPcmFormat(wav)).toEqual(format);
    // 0.5 s × 24,000 frames × 2 bytes, after the 44-byte header.
    expect(wav.length).toBe(44 + 24000);
    expect(wav.subarray(44).every((byte) => byte === 0)).toBe(true);
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
  const legacySegment = {
    id: "s01",
    startSec: 0,
    endSec: 4,
    voice: "hi-IN-Chirp3-HD-Kore",
    speakingRate: 1,
    markupUsed: "<speak>यह</speak>",
    inputMode: "ssml",
    billedChars: 20,
    latencyMs: 1200,
    measuredDurationSec: 4.2,
    pauseBeforeMs: 0,
    emphasisNotFound: [],
    emphasisPausedTerm: null,
    emphasisNotRealized: [],
  };

  it("still parses a job stored before utterances existed", () => {
    // Every job row is re-parsed on read; a breaking change here would 500 the
    // job list for anyone with an older job, the public demo included.
    const parsed = Synthesis.parse({
      audioUri: "gs://b/jobs/x/output.mp3",
      durationSec: 70,
      voice: "hi-IN-Chirp3-HD-Kore",
      segments: [legacySegment],
      billedChars: 20,
      measuredCharsPerSec: 12,
    });
    expect(parsed.utterances).toBeUndefined();
  });

  it("rejects a zero duration, the value a half-written record would carry", () => {
    expect(() =>
      SynthesizedSegment.parse({ ...legacySegment, measuredDurationSec: 0 })
    ).toThrow();
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
