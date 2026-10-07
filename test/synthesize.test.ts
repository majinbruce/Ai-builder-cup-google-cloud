import { describe, expect, it } from "vitest";
import { escapeConcatPath, parseHasPlayableVideo } from "../src/lib/ffmpeg.ts";
import {
  MAX_SPEAKING_RATE,
  MIN_SPEAKING_RATE,
  clampSpeakingRate,
} from "../src/lib/tts.ts";
import { loadPrompt } from "../src/lib/prompts.ts";
import { FIT_HEADROOM, MEASURED_CHARS_PER_SEC } from "../src/modules/localize/drift.ts";
import {
  findQuietRuns,
  pcmToWav,
  readMono16,
  readPcmFormat,
  silenceWav,
  sliceMono16,
} from "../src/lib/wav.ts";
import {
  BREATH_SEC,
  FIT_AIM,
  HOLD_PAST_SEC,
  LIP_GRACE_SEC,
  MAX_FIT_SPEEDUP,
  MAX_UTTERANCE_BYTES,
  MIN_FIT_TEMPO,
  MIN_LEAD_PHRASE_SEC,
  PACES,
  PACE_LENGTH,
  PAUSE_MS,
  PHRASE_EDGE_SEC,
  PHRASE_PAUSE_SEC,
  PHRASE_QUIET_DB,
  RETAKE_LATE_SEC,
  RETAKE_SILENT_SEC,
  buildSpeechDirection,
  buildSpeechStyle,
  chooseTake,
  endsSentence,
  groupIntoUtterances,
  paceOfRate,
  parsePaceWords,
  placeOnTimeline,
  placePhrases,
  planFit,
  rehearseTake,
  retakePace,
  silentLipsSec,
  speechWithin,
  splitIntoPhrases,
  timeFor,
  type TimelineSlot,
} from "../src/modules/localize/synthesize.stage.ts";
import {
  Synthesis,
  SynthesizedSegment,
  SynthesizedUtterance,
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
    spans.map(([id, startSec, endSec]) => [
      id,
      { id, startSec, endSec } as AnalyzedSegment,
    ])
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
      expect(Buffer.byteLength(group.text, "utf8")).toBeLessThanOrEqual(
        MAX_UTTERANCE_BYTES
      );
    }
  });
});

describe("placeOnTimeline — where each utterance lands in the output", () => {
  const slot = (overrides: Partial<TimelineSlot>): TimelineSlot => ({
    sourceStartSec: 0,
    deadlineSec: 10,
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

  it("pushes an utterance back a breath when the previous one ran long", () => {
    const placed = placeOnTimeline([
      slot({ sourceStartSec: 0, durationSec: 12 }),
      slot({ sourceStartSec: 10, durationSec: 3 }),
    ]);
    expect(placed.startSec[1]).toBeCloseTo(12 + BREATH_SEC, 6);
  });

  it("does not start an utterance late to make room for a pause", () => {
    // The previous utterance ends 0.2 s before this one's cue. A 700 ms lead
    // pause used to be added on top, putting the Hindi half a second behind.
    const placed = placeOnTimeline([
      slot({ sourceStartSec: 0, durationSec: 9.8 }),
      slot({ sourceStartSec: 10, durationSec: 3 }),
    ]);
    expect(placed.startSec[1]).toBe(10);
  });
});

describe("planFit — which utterances are re-timed, and by how much", () => {
  it("leaves an utterance that fits alone", () => {
    expect(planFit([{ sourceStartSec: 0, deadlineSec: 10, durationSec: 9.5 }])).toEqual([
      null,
    ]);
  });

  it("speeds up a small overrun too, rather than starting the next sentence late", () => {
    // 10 s of Hindi for a 10 s slot used to be left alone as "within 2%", and
    // the next utterance then started a breath after it: 0.12 s behind its cue
    // here, 0.28 s on a 14 s slot. The fit is exact now, so nothing is tolerated.
    const tempos = planFit([
      { sourceStartSec: 0, deadlineSec: 10, durationSec: 10 },
      { sourceStartSec: 10, deadlineSec: 20, durationSec: 5 },
    ]);
    expect(tempos[0]).toBeGreaterThan(1);
    expect(tempos[0]).toBeLessThan(1.05);

    const placed = placeOnTimeline([
      { sourceStartSec: 0, deadlineSec: 10, durationSec: 10 / (tempos[0] as number) },
      { sourceStartSec: 10, deadlineSec: 20, durationSec: 5 },
    ]);
    expect(placed.startSec[1]).toBe(10);
  });

  it("speeds an overrunning utterance up to land inside its deadline", () => {
    // The demo's s01: 12.19 s of Hindi for 10.2 s of English.
    const [tempo] = planFit([
      { sourceStartSec: 0, deadlineSec: 10.2, durationSec: 11.0 },
    ]);
    expect(tempo).not.toBeNull();
    expect(11.0 / (tempo as number)).toBeLessThan(10.2);
  });

  it("lets the last utterance run to the end of the clip untouched", () => {
    // Nothing follows it, so there is no cue to leave a breath for: 4.04 s of
    // Hindi in a 4.10 s slot (a real take) ends inside the clip as spoken.
    const tempos = planFit([
      { sourceStartSec: 0, deadlineSec: 56, durationSec: 50 },
      { sourceStartSec: 56, deadlineSec: 60.1, durationSec: 4.04 },
    ]);
    expect(tempos[1]).toBeNull();

    // Past the end of the clip it is still fitted, exactly and no further.
    const [, over] = planFit([
      { sourceStartSec: 0, deadlineSec: 56, durationSec: 50 },
      { sourceStartSec: 56, deadlineSec: 60.1, durationSec: 4.3 },
    ]);
    expect(4.3 / (over as number)).toBeCloseTo(4.1, 1);
  });

  it("caps the speed-up, so a learner hears brisk rather than rushed", () => {
    const [tempo] = planFit([{ sourceStartSec: 0, deadlineSec: 5, durationSec: 10 }]);
    expect(tempo).toBe(MAX_FIT_SPEEDUP);
  });

  it("slows an utterance that would leave most of its slot empty, within a cap", () => {
    const [mild, capped] = planFit([
      { sourceStartSec: 0, deadlineSec: 10, durationSec: 7.5 },
      { sourceStartSec: 10, deadlineSec: 20, durationSec: 3 },
    ]);
    expect(mild).toBeGreaterThan(MIN_FIT_TEMPO);
    expect(mild).toBeLessThan(1);
    // A slot that is mostly the teacher's own pause stays mostly silent.
    expect(capped).toBe(MIN_FIT_TEMPO);
  });

  it("slows a take toward the length it should last, when that is known", () => {
    // 8 s of Hindi that should last 8.5 s of a 10 s slot.
    const [tempo] = planFit([
      { sourceStartSec: 0, deadlineSec: 10, durationSec: 8, fillSec: 8.5 },
      { sourceStartSec: 10, deadlineSec: 20, durationSec: 5 },
    ]);
    expect(8 / (tempo as number)).toBeCloseTo(8.5, 1);
  });

  it("leaves a take that is as long as it should be alone, however empty the slot", () => {
    // The teacher speaks for 6 s of a 10 s slot and is silent for the rest.
    // Unmeasured, the slot looks 60% full and the take is slowed into that
    // silence; measured, the take is already exactly as long as it should be.
    const next = { sourceStartSec: 10, deadlineSec: 20, durationSec: 5 };
    const [measured] = planFit([
      { sourceStartSec: 0, deadlineSec: 10, durationSec: 6, fillSec: 6 },
      next,
    ]);
    expect(measured).toBeNull();

    const [unmeasured] = planFit([
      { sourceStartSec: 0, deadlineSec: 10, durationSec: 6 },
      next,
    ]);
    expect(unmeasured).toBe(MIN_FIT_TEMPO);
  });

  it("stops a slowed take the same beat short of the next cue as a sped-up one", () => {
    // No pause measured in this slot: the teacher talks right up to the cue.
    const [tempo] = planFit([
      { sourceStartSec: 0, deadlineSec: 10, durationSec: 9.3, fillSec: 9.88 },
      { sourceStartSec: 10, deadlineSec: 20, durationSec: 5 },
    ]);
    expect(9.3 / (tempo as number)).toBeCloseTo((10 - BREATH_SEC) * FIT_AIM, 1);
  });

  it("counts a late start against what the teacher still has to say", () => {
    // The first overruns even at top speed, so the second starts about 1.1 s
    // behind its cue. Of the 8 s it was meant to last, under 7 are left: 6.8 s
    // of Hindi is nearly all of it, and is barely slowed. Judged from the cue
    // it would have been slowed as far as the cap.
    const tempos = planFit([
      { sourceStartSec: 0, deadlineSec: 10, durationSec: 12.6 },
      { sourceStartSec: 10, deadlineSec: 20, durationSec: 6.8, fillSec: 8 },
      { sourceStartSec: 20, deadlineSec: 30, durationSec: 5 },
    ]);
    expect(tempos[0]).toBe(MAX_FIT_SPEEDUP);
    expect(tempos[1]).toBeGreaterThan(0.97);
    expect(tempos[1]).toBeLessThan(1);
  });

  it("counts a re-timed length forward, not the natural one", () => {
    // Without the carry-forward, the second would be judged as starting at 11 s.
    const tempos = planFit([
      { sourceStartSec: 0, deadlineSec: 10, durationSec: 11 },
      { sourceStartSec: 10, deadlineSec: 20, durationSec: 9.5 },
    ]);
    expect(tempos[0]).not.toBeNull();
    expect(tempos[1]).toBeNull();
  });
});

describe("buildSpeechDirection — what stage 1 heard, handed to the voice", () => {
  const source = {
    id: "s01",
    startSec: 0,
    endSec: 6,
    signal: "emphasis_shift",
    register: "cautionary",
  } as AnalyzedSegment;
  const [utterance] = groupIntoUtterances(
    [segment({ emphasisTerms: ["क्लोज़र", "नहीं है"] })],
    new Map([["s01", source]])
  );
  const direction = buildSpeechDirection(
    utterance as NonNullable<typeof utterance>,
    new Map([["s01", source]]),
    "a patient lecturer",
    6.4
  );

  it("carries the move, the mood and the time the passage has", () => {
    expect(direction).toContain("emphasis shift");
    expect(direction).toContain("mood cautionary");
    expect(direction).toContain("about 6 seconds");
    expect(direction).toContain("a patient lecturer");
  });

  it("asks for stress only on terms that are actually in the text", () => {
    expect(direction).toContain("lean on: क्लोज़र");
    expect(direction).not.toContain("नहीं है");
  });

  it("ends on the passage, exactly as it will be spoken", () => {
    expect(direction.endsWith("यह एक क्लोज़र है और यह ज़रूरी है।")).toBe(true);
  });

  it("asks for the pace it is given, in place of the adapter's rate", () => {
    const paced = buildSpeechDirection(
      utterance as NonNullable<typeof utterance>,
      new Map([["s01", source]]),
      "a patient lecturer",
      9,
      undefined,
      undefined,
      "speaking slowly and unhurried"
    );
    expect(paced).toContain("Pace: speaking slowly and unhurried. The whole passage");
    expect(paced).toContain("about 9 seconds");
    expect(direction).toContain("Pace: a natural, lively teaching pace.");
  });
});

describe("buildSpeechStyle — the same direction, for a model that takes a style", () => {
  const source = {
    id: "s01",
    startSec: 0,
    endSec: 6,
    signal: "warning",
    register: "cautionary",
  } as AnalyzedSegment;
  const byId = new Map([["s01", source]]);
  const [utterance] = groupIntoUtterances(
    [segment({ emphasisTerms: ["क्लोज़र", "नहीं है"] })],
    byId
  );
  const planned = utterance as NonNullable<typeof utterance>;
  const persona =
    "A woman presenting directly to camera, sharp and witty; her colleague is a foil.";

  it("is one line: who, mood, pace, the house phrase, the words to lean on", () => {
    // The exact shape sent to gemini-3.8-flash-tts on 2026-10-07, when four
    // lines came back at the length their text predicts.
    expect(buildSpeechStyle(planned, byId, persona, "conversational, not read out")).toBe(
      "A woman presenting directly to camera, sharp and witty. Mood cautionary; " +
        "a natural, lively pace; conversational, not read out. Lean on: क्लोज़र."
    );
  });

  it("never contains the passage: it is not something to be read", () => {
    const style = buildSpeechStyle(planned, byId, persona, "conversational");
    expect(style).not.toContain(planned.text);
  });

  it("describes someone else instead of the teacher when the line is theirs", () => {
    const style = buildSpeechStyle(planned, byId, persona, "conversational", {
      description: "colleague writing on the whiteboard",
    });
    expect(style.startsWith("colleague writing on the whiteboard.")).toBe(true);
    expect(style).not.toContain("A woman presenting");
  });

  it("asks for the pace it is given, in place of the adapter's rate", () => {
    const style = buildSpeechStyle(
      planned,
      byId,
      persona,
      "conversational, not read out",
      undefined,
      "speaking slowly and unhurried, with a clear pause between phrases"
    );
    expect(style).toBe(
      "A woman presenting directly to camera, sharp and witty. Mood cautionary; " +
        "speaking slowly and unhurried, with a clear pause between phrases; " +
        "conversational, not read out. Lean on: क्लोज़र."
    );
  });

  it("stays short, which is what keeps a 3.8 voice from drifting", () => {
    const long = `${"A patient lecturer who explains carefully".repeat(1)}. ${"More detail. ".repeat(40)}`;
    expect(buildSpeechStyle(planned, byId, long, "conversational").length).toBeLessThan(
      160
    );
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

describe("reading a take's own pauses", () => {
  const RATE = 24_000;
  const FORMAT = { sampleRate: RATE, channels: 1, bitsPerSample: 16 };

  /** A take built from stretches of tone at a given level, or none (silence). */
  function take(parts: [sec: number, levelDb: number | null][]): Int16Array {
    const samples: number[] = [];
    for (const [sec, levelDb] of parts) {
      const amplitude = levelDb === null ? 0 : 32767 * 10 ** (levelDb / 20) * Math.SQRT2;
      for (let i = 0; i < Math.round(sec * RATE); i += 1) {
        samples.push(Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE)));
      }
    }
    return Int16Array.from(samples);
  }

  const quiet = (samples: Int16Array) =>
    findQuietRuns(samples, RATE, {
      thresholdDb: PHRASE_QUIET_DB,
      minSec: PHRASE_PAUSE_SEC,
    });

  it("finds the pause between two phrases, to the frame", () => {
    const [run, ...rest] = quiet(
      take([
        [1, -12],
        [0.4, null],
        [1, -12],
      ])
    );
    expect(rest).toEqual([]);
    expect(run?.startSec).toBeCloseTo(1, 2);
    expect(run?.endSec).toBeCloseTo(1.4, 2);
  });

  it("counts breath as pause: the voice's pauses are quiet, not silent", () => {
    // Measured inside real takes: -49 dBFS at the median, never digital zero.
    const runs = quiet(
      take([
        [1, -12],
        [0.4, -50],
        [1, -12],
      ])
    );
    expect(runs).toHaveLength(1);
  });

  it("does not take a stop consonant for a pause", () => {
    // 0.12 s of closure inside a word is far under PHRASE_PAUSE_SEC.
    expect(
      quiet(
        take([
          [1, -12],
          [0.12, null],
          [1, -12],
        ])
      )
    ).toEqual([]);
  });

  it("does not take quiet speech for a pause", () => {
    expect(
      quiet(
        take([
          [1, -12],
          [0.5, -30],
          [1, -12],
        ])
      )
    ).toEqual([]);
  });

  it("round-trips a take through its WAV bytes", () => {
    const samples = take([[0.2, -12]]);
    const wav = pcmToWav(Buffer.from(samples.buffer), FORMAT);
    const read = readMono16(wav);
    expect(read.format).toEqual(FORMAT);
    expect(Array.from(read.samples)).toEqual(Array.from(samples));
  });

  it("refuses a file that is not 16-bit mono rather than misreading it", () => {
    const stereo = silenceWav(0.1, { sampleRate: RATE, channels: 2, bitsPerSample: 16 });
    expect(() => readMono16(stereo)).toThrow(/16-bit mono/);
  });

  it("cuts a phrase out with a fade at each edge and nothing changed between", () => {
    const samples = take([[1, -12]]);
    const piece = readMono16(sliceMono16(samples, FORMAT, 2400, 12_000)).samples;

    expect(piece).toHaveLength(9600);
    // Silent at the very edges, so a cut inside a breath cannot click...
    expect(piece[0]).toBe(0);
    expect(piece[piece.length - 1]).toBe(0);
    // ...and bit-identical once the 5 ms fade is over.
    expect(Array.from(piece.subarray(200, 9400))).toEqual(
      Array.from(samples.subarray(2600, 11_800))
    );
  });
});

describe("splitIntoPhrases — where the voice ended one thought and began another", () => {
  it("cuts at an internal pause, leaving a little of it on each phrase", () => {
    const phrases = splitIntoPhrases([{ startSec: 4.13, endSec: 4.57 }], 6.01);
    expect(phrases).toEqual([
      { startSec: 0, endSec: 4.13 + PHRASE_EDGE_SEC },
      { startSec: 4.57 - PHRASE_EDGE_SEC, endSec: 6.01 },
    ]);
  });

  it("is one phrase when the voice never paused", () => {
    expect(splitIntoPhrases([], 3.2)).toEqual([{ startSec: 0, endSec: 3.2 }]);
  });

  it("ignores quiet at the take's own edges", () => {
    // conformSpeech leaves ~20 ms at each end; that is not a pause between phrases.
    const phrases = splitIntoPhrases(
      [
        { startSec: 0, endSec: 0.3 },
        { startSec: 4.7, endSec: 5 },
      ],
      5
    );
    expect(phrases).toHaveLength(1);
  });

  it("keeps a short lead-in joined to what follows it", () => {
    // "तो," then a pause: held alone before a four-second wait, it is a broken
    // sentence. The cut after it is skipped.
    const lead = MIN_LEAD_PHRASE_SEC - 0.2;
    const phrases = splitIntoPhrases(
      [
        { startSec: lead, endSec: lead + 0.3 },
        { startSec: 3, endSec: 3.4 },
      ],
      6
    );
    expect(phrases).toHaveLength(2);
    expect(phrases[0]?.endSec).toBe(3 + PHRASE_EDGE_SEC);
  });

  it("lets a short LAST phrase stand: a tag question waits for the teacher's", () => {
    // Real take: "…इसे हम एरे कहते हैं। | ठीक है?" — 0.31 s after the pause.
    const phrases = splitIntoPhrases([{ startSec: 3.51, endSec: 3.89 }], 4.15);
    expect(phrases).toHaveLength(2);
    expect((phrases[1]?.endSec ?? 0) - (phrases[1]?.startSec ?? 0)).toBeLessThan(
      MIN_LEAD_PHRASE_SEC
    );
  });
});

describe("placePhrases — a phrase held until the teacher starts again", () => {
  /**
   * The dense-jargon clip, utterance 1, as replayed from its stored take. The
   * lecturer spreads "the most widely used machine learning tool is … today is
   * supervised learning" over 12 s and says "supervised" at 21.7 s. The voice
   * said the whole sentence in 6 s, and the key term at 15.7 s.
   */
  const phrases = [
    { startSec: 0, endSec: 4.18 },
    { startSec: 4.52, endSec: 6.01 },
  ];
  const lecturerPauses = [
    { startSec: 16.1, endSec: 16.7 },
    { startSec: 17, endSec: 17.2 },
    { startSec: 17.3, endSec: 17.6 },
    { startSec: 18.1, endSec: 18.7 },
    { startSec: 19.2, endSec: 19.5 },
  ];

  it("starts the first phrase on the cue, always", () => {
    expect(placePhrases(phrases, 10.94, 23.08, lecturerPauses)[0]).toBe(10.94);
  });

  it("holds the key term until the lecturer's last pause before it ends", () => {
    const starts = placePhrases(phrases, 10.94, 23.08, lecturerPauses);
    // As spoken it would start at 15.46; it waits 4 s, for the 19.5 s onset.
    expect(starts[1]).toBe(19.5);
    // And still ends inside its slot, so the next cue is not touched.
    expect((starts[1] ?? 0) + 1.49).toBeLessThan(23.08);
  });

  it("runs on as spoken when the teacher never paused", () => {
    const starts = placePhrases(phrases, 10.94, 23.08, []);
    expect(starts[1]).toBeCloseTo(10.94 + 4.52, 6);
  });

  it("runs on when there is no time to spare", () => {
    // The slot ends where the take does: any hold would make the next cue late.
    const starts = placePhrases(phrases, 10.94, 10.94 + 6.01, lecturerPauses);
    expect(starts[1]).toBeCloseTo(10.94 + 4.52, 6);
  });

  it("never holds a phrase so long that the rest cannot end in time", () => {
    // A pause ends at 5.5, but the second phrase has to start by 4.3 to finish.
    const two = [
      { startSec: 0, endSec: 2 },
      { startSec: 2.3, endSec: 4 },
    ];
    const starts = placePhrases(two, 0, 6, [{ startSec: 4, endSec: 5.5 }]);
    expect(starts[1]).toBeCloseTo(2.3, 6);
  });

  it("does not wait for a pause that ends long after the teacher is level with it", () => {
    // The teacher is as far through at ~5.9 s as the Hindi is at its pause. The
    // only pause to wait for ends at 10 s: holding for it would leave the Hindi
    // four seconds BEHIND instead of ahead.
    const two = [
      { startSec: 0, endSec: 2 },
      { startSec: 2.3, endSec: 4 },
    ];
    const starts = placePhrases(two, 0, 12, [{ startSec: 9, endSec: 10 }]);
    expect(10 - 5.946).toBeGreaterThan(HOLD_PAST_SEC);
    expect(starts[1]).toBeCloseTo(2.3, 6);
  });

  it("does not go back for a pause the Hindi has already passed", () => {
    const two = [
      { startSec: 0, endSec: 3 },
      { startSec: 3.4, endSec: 6 },
    ];
    const starts = placePhrases(two, 0, 8, [{ startSec: 1, endSec: 1.5 }]);
    expect(starts[1]).toBeCloseTo(3.4, 6);
  });

  it("carries a hold forward to the phrases after it", () => {
    const three = [
      { startSec: 0, endSec: 2 },
      { startSec: 2.4, endSec: 4 },
      { startSec: 4.3, endSec: 5 },
    ];
    // One pause, right where the teacher is a third of the way through.
    const starts = placePhrases(three, 0, 12, [{ startSec: 4, endSec: 5 }]);
    expect(starts[1]).toBe(5);
    // The third phrase follows the second at the voice's own gap, not the cue's.
    expect(starts[2]).toBeCloseTo(5 + 1.6 + 0.3, 6);
  });
});

describe("speechWithin and timeFor — the room a take has, and the teacher in it", () => {
  it("is the span less every pause measured in it", () => {
    expect(
      speechWithin(10, 20, [
        { startSec: 12, endSec: 12.5 },
        { startSec: 15, endSec: 16 },
      ])
    ).toBeCloseTo(8.5, 6);
  });

  it("counts only the part of a pause that is inside the span", () => {
    // One pause straddles the start, one the end, one is elsewhere entirely.
    expect(
      speechWithin(10, 20, [
        { startSec: 9.6, endSec: 10.4 },
        { startSec: 19.7, endSec: 21 },
        { startSec: 30, endSec: 31 },
      ])
    ).toBeCloseTo(10 - 0.4 - 0.3, 6);
  });

  it("leaves a breath before the next cue out of the room, except at the end", () => {
    const pauses = [{ startSec: 50, endSec: 51 }];
    expect(timeFor(0, 10, false, pauses).roomSec).toBeCloseTo(10 - BREATH_SEC, 6);
    expect(timeFor(0, 10, true, pauses).roomSec).toBe(10);
  });

  it("takes the pause the next cue was anchored to out of the teacher's speech", () => {
    // A real slot (the TEDx talk): cue 32.448, next cue 40.395, and the pause
    // before that cue, 40.137-40.395.
    const timing = timeFor(32.448, 40.395, false, [{ startSec: 40.137, endSec: 40.395 }]);
    expect(timing.roomSec).toBeCloseTo(7.827, 3);
    expect(timing.speechSec).toBeCloseTo(7.689, 3);
  });

  it("does not claim to know the teacher's speech when nobody measured the pauses", () => {
    expect(timeFor(0, 10, false, []).speechSec).toBeUndefined();
  });
});

describe("silentLipsSec — what a viewer watches with nothing to hear", () => {
  const none: { startSec: number; endSec: number }[] = [];

  it("counts the teacher speaking after the Hindi has stopped, past the grace", () => {
    // The Hindi ends at 6; the teacher goes on to 10.
    expect(silentLipsSec([{ startSec: 0, endSec: 6 }], 0, 10, none)).toBeCloseTo(
      4 - LIP_GRACE_SEC,
      6
    );
  });

  it("does not count the teacher's own pause: still lips need no voice", () => {
    expect(
      silentLipsSec([{ startSec: 0, endSec: 6 }], 0, 10, [{ startSec: 6, endSec: 10 }])
    ).toBe(0);
  });

  it("forgives every stretch a pause's worth, so a voice may breathe", () => {
    // Three gaps of 0.3 s between phrases, with the teacher talking throughout.
    const playing = [
      { startSec: 0, endSec: 2 },
      { startSec: 2.3, endSec: 5 },
      { startSec: 5.3, endSec: 8 },
      { startSec: 8.3, endSec: 10 },
    ];
    expect(silentLipsSec(playing, 0, 10, none)).toBe(0);
  });

  it("counts a stretch on each side of a pause separately", () => {
    // Hindi to 4, then nothing. The teacher talks 4-5, pauses 5-6, talks 6-7.5.
    expect(
      silentLipsSec([{ startSec: 0, endSec: 4 }], 0, 7.5, [{ startSec: 5, endSec: 6 }])
    ).toBeCloseTo(1 - LIP_GRACE_SEC + (1.5 - LIP_GRACE_SEC), 6);
  });

  it("looks only inside the span it is asked about", () => {
    expect(silentLipsSec([{ startSec: 0, endSec: 20 }], 5, 10, none)).toBe(0);
    expect(silentLipsSec(none, 5, 10, none)).toBeCloseTo(5 - LIP_GRACE_SEC, 6);
  });
});

describe("the pace ladder", () => {
  it("runs from briskest to slowest, natural being 1", () => {
    const lengths = PACES.map((pace) => PACE_LENGTH[pace]);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(new Set(lengths).size).toBe(lengths.length);
    expect(PACE_LENGTH.natural).toBe(1);
  });

  it("records a first take at the pace the adapter's rate asks for", () => {
    expect(paceOfRate(1)).toBe("natural");
    expect(paceOfRate(0.95)).toBe("natural");
    expect(paceOfRate(0.9)).toBe("unhurried");
    expect(paceOfRate(0.85)).toBe("unhurried");
    expect(paceOfRate(1.08)).toBe("brisk");
  });
});

// Three real slots from the first videos voiced on gemini-3.8-flash-tts, each
// with the take it got and that take's own pauses (findQuietRuns).
const runs = (pairs: [number, number][]) =>
  pairs.map(([startSec, endSec]) => ({ startSec, endSec }));

// The lecture: 14 s with no pause of the lecturer's in it.
const lecture = {
  timing: timeFor(0, 14, false, runs([[31.428, 31.656]])),
  pauses: runs([[31.428, 31.656]]),
  natural: {
    durationSec: 9.34,
    quiet: runs([
      [1.71, 2.01],
      [2.79, 3.09],
      [4.05, 4.36],
      [6.34, 6.74],
    ]),
  },
  // The same line asked to speak slowly: the second take, as recorded.
  slow: {
    durationSec: 13.738,
    quiet: runs([
      [0.6, 1.02],
      [2.57, 3.01],
      [4.59, 5.1],
      [6.2, 6.65],
      [7.57, 8.01],
      [9.62, 10.46],
      [11.63, 11.91],
    ]),
  },
};
// The talk: a fast speaker, and a take a quarter longer than its room.
const talkPauses = runs([[40.137, 40.395]]);
const talk = {
  timing: timeFor(32.448, 40.395, false, talkPauses),
  pauses: talkPauses,
  natural: { durationSec: 9.932, quiet: runs([[2.67, 3.15]]) },
};
// The board: the lecturer pauses five times in 3.4 s, then talks to the cue.
const boardPauses = runs([
  [16.149, 16.727],
  [16.98, 17.212],
  [17.316, 17.63],
  [18.085, 18.72],
  [19.197, 19.513],
]);
const board = {
  timing: timeFor(12.3, 22.8, false, boardPauses),
  pauses: boardPauses,
  // Asked for "slow and deliberate". Its one pause is after the first word,
  // too early to cut at, so it is said in one piece.
  unhurried: { durationSec: 6.976, quiet: runs([[0.52, 1.17]]) },
};

const rehearse = (
  take: { durationSec: number; quiet: { startSec: number; endSec: number }[] },
  slot: { timing: ReturnType<typeof timeFor>; pauses: typeof talkPauses }
) => rehearseTake(take.durationSec, take.quiet, slot.timing, slot.pauses);

describe("rehearseTake — what using a take would look like", () => {
  it("slows a short take as far as it goes and reports what is still unheard", () => {
    // 9.34 s for a lecturer who talks for 13.9: slowed a tenth it ends at
    // 10.4 s, and he is seen talking for another 3.1 s.
    const rehearsal = rehearse(lecture.natural, lecture);
    expect(rehearsal.tempo).toBe(MIN_FIT_TEMPO);
    expect(rehearsal.lateSec).toBe(0);
    expect(rehearsal.silentSec).toBeCloseTo(
      13.88 * FIT_AIM - 9.34 / MIN_FIT_TEMPO - LIP_GRACE_SEC,
      2
    );
  });

  it("finds the slow take of the same line fits as it was spoken", () => {
    const rehearsal = rehearse(lecture.slow, lecture);
    expect(rehearsal.tempo).toBe(1);
    expect(rehearsal.lateSec).toBe(0);
    // What is left is the voice's own longer pauses, one of them 0.84 s.
    expect(rehearsal.silentSec).toBeLessThan(0.5);
  });

  it("speeds a long take up and reports how late it leaves the next line", () => {
    // At top speed 9.93 s still runs 0.8 s past its room: this is the line
    // that put three in a row behind the picture.
    const rehearsal = rehearse(talk.natural, talk);
    expect(rehearsal.tempo).toBe(MAX_FIT_SPEEDUP);
    expect(rehearsal.lateSec).toBeCloseTo(9.932 / MAX_FIT_SPEEDUP - 7.827, 3);
    expect(rehearsal.silentSec).toBe(0);
  });

  it("sees a take that is long enough and still leaves the teacher unheard", () => {
    // By length this take nearly does: 7.75 s slowed, for 8.3 s of speech. But
    // it has nowhere to wait while the lecturer pauses, talks through all
    // five, and is over at 20.05 s when he talks until 22.8.
    const rehearsal = rehearse(board.unhurried, board);
    expect(board.timing.speechSec).toBeCloseTo(8.305, 3);
    expect(rehearsal.tempo).toBe(MIN_FIT_TEMPO);

    const afterItEnds =
      12.3 + 10.38 * FIT_AIM - (12.3 + 6.976 / MIN_FIT_TEMPO) - LIP_GRACE_SEC;
    // Slowed, its own pause after the first word is long enough to show too.
    const afterItsFirstWord =
      (1.17 - 0.52) / MIN_FIT_TEMPO - 2 * PHRASE_EDGE_SEC - LIP_GRACE_SEC;
    expect(rehearsal.shortSec).toBeCloseTo(afterItEnds, 2);
    expect(rehearsal.silentSec).toBeCloseTo(afterItEnds + afterItsFirstWord, 2);
    expect(afterItEnds).toBeGreaterThan(1.9);
  });

  it("leaves a take as spoken when waiting at a pause already brings it out level", () => {
    // The teacher talks 0-4, is silent 4-6, talks 6-10. The take is 7.5 s with
    // a pause of its own at 3.8 s: its second phrase waits for the teacher,
    // and it ends with him. Slowing it would only smear a take that fits.
    const pauses = runs([[4, 6]]);
    const timing = timeFor(0, 10, false, pauses);
    const rehearsal = rehearseTake(7.5, runs([[3.8, 4.2]]), timing, pauses);
    expect(rehearsal).toEqual({ tempo: 1, lateSec: 0, silentSec: 0, shortSec: 0 });

    // By its length alone it would have been slowed: 7.5 s for 7.88 s of speech.
    expect(timing.speechSec).toBeCloseTo(7.88, 6);
  });

  it("counts the teacher talking while the Hindi waits at a hold as too short", () => {
    // The teacher talks 0-4.8, is silent to 5.8, talks on to 10. The take says
    // its first phrase in a little over 2 s and then waits for him to start
    // again: 2.5 s of the teacher talking with nothing to hear, before a tail
    // of 2 s more.
    const pauses = runs([[4.8, 5.8]]);
    const timing = timeFor(0, 10, false, pauses);
    const rehearsal = rehearseTake(4, runs([[2, 2.4]]), timing, pauses);
    // Slowed nearly as far as it goes; the last hundredth gains too little.
    expect(rehearsal.tempo).toBeLessThanOrEqual(MIN_FIT_TEMPO + 0.02);

    const firstPhraseEnds = 2 / rehearsal.tempo + PHRASE_EDGE_SEC;
    const lastPhraseEnds = 5.8 + (4 - 2.4) / rehearsal.tempo + PHRASE_EDGE_SEC;
    const atTheHold = 4.8 - firstPhraseEnds - LIP_GRACE_SEC;
    const afterItEnds = 9.88 * FIT_AIM - lastPhraseEnds - LIP_GRACE_SEC;
    expect(atTheHold).toBeGreaterThan(2);
    expect(rehearsal.shortSec).toBeCloseTo(atTheHold + afterItEnds, 2);
    expect(rehearsal.silentSec).toBeCloseTo(rehearsal.shortSec, 6);
    expect(retakePace("natural", 4, rehearsal, timing)).toBe("slow");
  });

  it("slows the same take when it has no pause to wait at", () => {
    const pauses = runs([[4, 6]]);
    const rehearsal = rehearseTake(7.5, [], timeFor(0, 10, false, pauses), pauses);
    expect(rehearsal.tempo).toBe(MIN_FIT_TEMPO);
    // It talks through the teacher's pause, and is over 1.25 s before he is.
    expect(rehearsal.silentSec).toBeCloseTo(
      9.88 * FIT_AIM - 7.5 / MIN_FIT_TEMPO - LIP_GRACE_SEC,
      2
    );
  });

  it("does not slow a take for a gain nobody would see", () => {
    // 9.2 s where the teacher talks to 9.58: the 0.38 s left is within the
    // grace as it stands, so there is nothing to be had from a re-time.
    const pauses = runs([[50, 51]]);
    const rehearsal = rehearseTake(9.2, [], timeFor(0, 10, false, pauses), pauses);
    expect(rehearsal).toEqual({ tempo: 1, lateSec: 0, silentSec: 0, shortSec: 0 });
  });

  it("never stretches a take into the beat before the next cue", () => {
    // 9.7 s in a 9.88 s room: already past the beat, so it is left alone.
    const pauses = runs([[50, 51]]);
    expect(rehearseTake(9.7, [], timeFor(0, 10, false, pauses), pauses).tempo).toBe(1);
  });

  it("gives no verdict on silence when nobody measured the teacher's pauses", () => {
    const rehearsal = rehearseTake(6, [], timeFor(0, 10, false, []), []);
    // The old estimate still slows it: four fifths of the slot is speech.
    expect(rehearsal.tempo).toBe(MIN_FIT_TEMPO);
    expect(rehearsal.silentSec).toBe(0);
    expect(rehearsal.shortSec).toBe(0);
  });
});

describe("retakePace — when a line is recorded again, and at what pace", () => {
  it("leaves a take that fits alone", () => {
    const fits = { tempo: 1, lateSec: 0, silentSec: 0.2, shortSec: RETAKE_SILENT_SEC };
    expect(retakePace("natural", 12, fits, lecture.timing)).toBeUndefined();
    const onTime = { tempo: 1.1, lateSec: RETAKE_LATE_SEC, silentSec: 0, shortSec: 0 };
    expect(retakePace("natural", 12, onTime, lecture.timing)).toBeUndefined();
  });

  it("does not record again for a pause in the middle that a longer take cannot move", () => {
    // The slow take of the lecture line ends with the lecturer. Its own pauses
    // are long, one of them 0.84 s, and that is all that is left unheard.
    const rehearsal = rehearse(lecture.slow, lecture);
    expect(rehearsal.silentSec).toBeGreaterThan(RETAKE_SILENT_SEC);
    expect(rehearsal.shortSec).toBe(0);
    expect(retakePace("unhurried", 13.738, rehearsal, lecture.timing)).toBeUndefined();
  });

  it("asks for a slower take when the teacher would talk on unheard", () => {
    // Slowed all the way it lasts 10.4 s and leaves 2.7 s unheard: 13.1 s is
    // wanted, 1.4 times the take. The unhurried pace measures 1.15.
    expect(
      retakePace("natural", 9.34, rehearse(lecture.natural, lecture), lecture.timing)
    ).toBe("slow");
  });

  it("asks for a brisker take when the next line would start late", () => {
    expect(retakePace("natural", 9.932, rehearse(talk.natural, talk), talk.timing)).toBe(
      "brisk"
    );
  });

  it("asks for a slower take of one that was long enough but had nowhere to wait", () => {
    expect(
      retakePace("unhurried", 6.976, rehearse(board.unhurried, board), board.timing)
    ).toBe("slow");
  });

  it("reads the first take as a measurement of this passage, at the pace it was asked for", () => {
    // 11.4 s asked to speak slowly is far too long for the talk's 7.8 s. It
    // says the passage runs 7.6 s at the natural pace, which is what fits —
    // where 11.4 s read as a natural take would have asked for the briskest
    // there is.
    const tooLong = rehearseTake(11.4, [], talk.timing, talk.pauses);
    expect(tooLong.lateSec).toBeGreaterThan(RETAKE_LATE_SEC);
    expect(11.4 / PACE_LENGTH.slow).toBeCloseTo(talk.timing.roomSec * FIT_AIM, 1);
    expect(retakePace("slow", 11.4, tooLong, talk.timing)).toBe("natural");
    expect(retakePace("natural", 11.4, tooLong, talk.timing)).toBe("brisk");
  });

  it("stops asking at the ends of the ladder", () => {
    expect(
      retakePace("slow", 9.34, rehearse(lecture.natural, lecture), lecture.timing)
    ).toBeUndefined();
    expect(
      retakePace("brisk", 9.932, rehearse(talk.natural, talk), talk.timing)
    ).toBeUndefined();
  });

  it("looks only on the side of the miss, and never asks for the pace it has heard", () => {
    for (const first of PACES) {
      const tried = PACES.indexOf(first);
      const slower = retakePace(
        first,
        9.34,
        rehearse(lecture.natural, lecture),
        lecture.timing
      );
      if (slower !== undefined) expect(PACES.indexOf(slower)).toBeGreaterThan(tried);
      const brisker = retakePace(first, 9.932, rehearse(talk.natural, talk), talk.timing);
      if (brisker !== undefined) expect(PACES.indexOf(brisker)).toBeLessThan(tried);
    }
  });
});

describe("chooseTake — which of two takes is heard", () => {
  it("keeps the take that fits: the real second take of the lecture line", () => {
    expect(
      chooseTake([rehearse(lecture.natural, lecture), rehearse(lecture.slow, lecture)])
    ).toBe(1);
  });

  it("keeps the first when the second is no better", () => {
    const same = { lateSec: 0, silentSec: 1.2 };
    expect(chooseTake([same, { ...same }])).toBe(0);
    expect(chooseTake([same, { lateSec: 0, silentSec: 1.5 }])).toBe(0);
  });

  it("counts a second of lateness as worse than a second of silence", () => {
    const silent = { lateSec: 0, silentSec: 0.8 };
    expect(chooseTake([{ lateSec: 0.8, silentSec: 0 }, silent])).toBe(1);
    // But not at any price: a little late beats a long silence.
    expect(chooseTake([silent, { lateSec: 0.25, silentSec: 0 }])).toBe(1);
  });

  it("is the only take when there is only one", () => {
    expect(chooseTake([{ lateSec: 3, silentSec: 3 }])).toBe(0);
  });
});

describe("parsePaceWords — the words each pace is asked for in", () => {
  it("reads every pace on the ladder out of pace.v1.md", () => {
    const words = parsePaceWords(loadPrompt("pace.v1"));
    expect(Object.keys(words).sort()).toEqual([...PACES].sort());
    for (const pace of PACES) expect(words[pace].length).toBeGreaterThan(5);
    // The two phrases whose effect on a take was measured, word for word.
    expect(words.natural).toBe("a natural, lively pace");
    expect(words.slow).toBe(
      "speaking slowly and unhurried, with a clear pause between phrases"
    );
  });

  it("keeps a colon inside the words", () => {
    const words = parsePaceWords(
      "brisk: quick\nnatural: plain\nunhurried: easy: no rush\nslow: slowly"
    );
    expect(words.unhurried).toBe("easy: no rush");
  });

  it("refuses a file that leaves a pace without words", () => {
    expect(() => parsePaceWords("brisk: quick\nnatural: plain\nslow: slowly")).toThrow(
      /unhurried/
    );
    expect(() =>
      parsePaceWords("brisk: quick\nnatural:\nunhurried: easy\nslow: slowly")
    ).toThrow(/natural/);
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

  const utterance = {
    index: 0,
    segmentIds: ["s01"],
    sourceStartSec: 0,
    deadlineSec: 14,
    markupUsed: "यह",
    inputMode: "text",
    engine: "gemini",
    requestedRate: 1,
    speakingRate: 1,
    naturalDurationSec: 13.74,
    measuredDurationSec: 13.74,
    refit: false,
    pauseBeforeMs: 0,
    outputStartSec: 0,
    billedChars: 4,
    latencyMs: 16000,
  };

  it("parses an utterance from before a pace was asked for", () => {
    const parsed = SynthesizedUtterance.parse(utterance);
    expect(parsed.pace).toBeUndefined();
    expect(parsed.takes).toBeUndefined();
    expect(parsed.speechSec).toBeUndefined();
  });

  it("carries both takes of a line that was recorded twice, and which is heard", () => {
    const parsed = SynthesizedUtterance.parse({
      ...utterance,
      speechSec: 13.88,
      pace: "slow",
      takes: [
        { pace: "natural", durationSec: 9.34, lateSec: 0, silentSec: 2.69, kept: false },
        { pace: "slow", durationSec: 13.74, lateSec: 0, silentSec: 0.35, kept: true },
      ],
    });
    expect(parsed.takes?.filter((take) => take.kept)).toHaveLength(1);
  });

  it("does not call one take a re-take", () => {
    expect(() =>
      SynthesizedUtterance.parse({
        ...utterance,
        takes: [
          { pace: "natural", durationSec: 9.34, lateSec: 0, silentSec: 0, kept: true },
        ],
      })
    ).toThrow();
  });
});

describe("FIT_HEADROOM", () => {
  it("is exactly what stage 4 will speed an utterance up by", () => {
    // drift.ts cannot import this module (it is imported BY it), so the number
    // is written twice. The retry gate is computed from it: if the two drift
    // apart, text is either sent back that would have fitted or let through
    // that cannot.
    expect(1 + FIT_HEADROOM).toBeCloseTo(MAX_FIT_SPEEDUP, 10);
  });
});

describe("MEASURED_CHARS_PER_SEC", () => {
  it("is the rate measured on the voice that is live", () => {
    // Guards the claim in docs/research.md: 13 by arithmetic, 12.72 measured on
    // hi-IN-Chirp3-HD-Kore, 10.97 measured on directed Gemini TTS (Charon). The
    // adapt stage budgets its Hindi from this, so a voice change that leaves it
    // alone puts every sentence behind the picture — the test is here so the
    // docs and the code cannot quietly disagree about which one is live.
    expect(MEASURED_CHARS_PER_SEC).toBeCloseTo(10.97, 2);
  });
});
