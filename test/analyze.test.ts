import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseMeanVolumeDb,
  parseRmsWindows,
  parseSilences,
  type Silence,
} from "../src/lib/ffmpeg.ts";
import {
  chooseSilenceThreshold,
  collapseProminentRanges,
  formatAcousticsForPrompt,
  formatTimestamp,
  markProminence,
} from "../src/modules/localize/acoustics.ts";
import { corroborate } from "../src/modules/localize/corroborate.ts";
import {
  Analysis,
  type AcousticEvidence,
} from "../src/modules/localize/localize.schemas.ts";

/**
 * Stage 1 without a network call, without ffmpeg, and without an audio file.
 *
 * Everything Gemini does is untestable here by definition — a mocked model
 * proves nothing about a prompt. What IS testable is the machinery around it,
 * and that machinery is where a silent wrong answer would hide: a regex that
 * stops matching after an ffmpeg upgrade produces an empty pause list, an empty
 * pause list produces zero corroboration, and zero corroboration looks exactly
 * like a model that hallucinated its prosody claims. So the ffmpeg text
 * fixtures below are captured from real runs on fixtures/sample_60s.mp3.
 *
 * The model's actual output is verified by running it: `npm run stage:analyze`,
 * read the labels against the clip. That is a human check and this file does
 * not pretend to replace it.
 */

// Captured verbatim from: ffmpeg -i fixtures/sample_60s.mp3
//   -af silencedetect=noise=-22dB:d=0.20 -f null -
const SILENCEDETECT_STDERR = `
[silencedetect @ 0x5a255c0f1780] silence_start: 11.7074
[silencedetect @ 0x5a255c0f1780] silence_end: 11.9529 | silence_duration: 0.245563
[silencedetect @ 0x5a255c0f1780] silence_start: 32.6868
[silencedetect @ 0x5a255c0f1780] silence_end: 32.9023 | silence_duration: 0.215563
[silencedetect @ 0x5a255c0f1780] silence_start: 61.0564
[silencedetect @ 0x5a255c0f1780] silence_end: 61.3775 | silence_duration: 0.321125
`;

// Captured verbatim from the ametadata=print stream.
const AMETADATA_STDOUT = `
frame:0    pts:0       pts_time:0
lavfi.astats.Overall.RMS_level=-14.392920
frame:1    pts:8000    pts_time:0.5
lavfi.astats.Overall.RMS_level=-16.614334
frame:2    pts:16000   pts_time:1
lavfi.astats.Overall.RMS_level=-17.048014
`;

describe("ffmpeg output parsing", () => {
  it("reads the mean level out of volumedetect's stderr", () => {
    const stderr = `[Parsed_volumedetect_0 @ 0x5a0f] mean_volume: -16.4 dB
[Parsed_volumedetect_0 @ 0x5a0f] max_volume: 0.0 dB`;

    expect(parseMeanVolumeDb(stderr)).toBe(-16.4);
  });

  it("throws rather than guessing when volumedetect prints nothing usable", () => {
    expect(() => parseMeanVolumeDb("ffmpeg version 6.1.1")).toThrow(/mean_volume/);
  });

  it("pairs silence_start with silence_end", () => {
    const silences = parseSilences(SILENCEDETECT_STDERR);

    expect(silences).toHaveLength(3);
    expect(silences[0]?.startSec).toBe(11.7074);
    expect(silences[0]?.endSec).toBe(11.9529);
    expect(silences[0]?.durationSec).toBeCloseTo(0.2455, 3);
  });

  it("drops a silence still open at the end of the clip", () => {
    // Trailing room tone is not a pedagogical pause, and counting it would
    // inflate the density the threshold ladder steers by.
    const silences = parseSilences(`
[silencedetect] silence_start: 10.0
[silencedetect] silence_end: 10.5 | silence_duration: 0.5
[silencedetect] silence_start: 62.0
`);

    expect(silences).toHaveLength(1);
  });

  it("reads the windowed RMS series with its timestamps", () => {
    const windows = parseRmsWindows(AMETADATA_STDOUT);

    expect(windows).toEqual([
      { startSec: 0, rmsDb: -14.39292 },
      { startSec: 0.5, rmsDb: -16.614334 },
      { startSec: 1, rmsDb: -17.048014 },
    ]);
  });

  it("floors digital silence at -120 dB instead of yielding -Infinity", () => {
    const windows = parseRmsWindows(`
frame:0    pts:0       pts_time:0
lavfi.astats.Overall.RMS_level=-inf
`);

    expect(windows[0]?.rmsDb).toBe(-120);
  });
});

describe("adaptive silence threshold", () => {
  const silencesOfLength = (count: number): Silence[] =>
    Array.from({ length: count }, (_, i) => ({
      startSec: i,
      endSec: i + 0.3,
      durationSec: 0.3,
    }));

  it("stops at the first offset with a plausible pause density", async () => {
    // 63s clip: 11 pauses is ~10.5/min, inside the 6-15 band. The ladder starts
    // at mean-4 and should not walk past the first step that qualifies.
    const tried: number[] = [];

    const result = await chooseSilenceThreshold(-16.4, 63.1, (thresholdDb) => {
      tried.push(thresholdDb);
      return Promise.resolve(silencesOfLength(thresholdDb === -22.4 ? 11 : 1));
    });

    expect(tried).toEqual([-20.4, -22.4]);
    expect(result.thresholdDb).toBe(-22.4);
    expect(result.offsetDb).toBe(6);
    expect(result.pauses).toHaveLength(11);
  });

  it("falls back to the offset that found the most pauses when none qualifies", async () => {
    // A clip where every threshold is either too strict or too loose still has
    // to produce a pause list; returning nothing would mean no boundaries and
    // no corroboration at all.
    const byThreshold = new Map([
      [-20.4, 0],
      [-22.4, 1],
      [-24.4, 40],
      [-28.4, 90],
      [-32.4, 120],
    ]);

    const result = await chooseSilenceThreshold(-16.4, 63.1, (thresholdDb) =>
      Promise.resolve(silencesOfLength(byThreshold.get(thresholdDb) ?? 0))
    );

    expect(result.pauses).toHaveLength(120);
  });
});

describe("prominence", () => {
  it("marks windows at or above the median + 3 dB", () => {
    const { medianRmsDb, prominenceThresholdDb, marked } = markProminence([
      { startSec: 0, rmsDb: -20 },
      { startSec: 0.5, rmsDb: -20 },
      { startSec: 1, rmsDb: -16 },
      { startSec: 1.5, rmsDb: -21 },
      { startSec: 2, rmsDb: -17 },
    ]);

    expect(medianRmsDb).toBe(-20);
    expect(prominenceThresholdDb).toBe(-17);
    expect(marked.map((w) => w.prominent)).toEqual([false, false, true, false, true]);
  });
});

/** A minimal evidence object; individual tests override what they care about. */
function evidenceWith(overrides: Partial<AcousticEvidence>): AcousticEvidence {
  return {
    durationSec: 30,
    meanVolumeDb: -16.4,
    silenceThresholdDb: -22.4,
    thresholdOffsetDb: 6,
    windowSec: 0.5,
    medianRmsDb: -20,
    prominenceThresholdDb: -17,
    pauses: [],
    windows: [],
    ...overrides,
  };
}

describe("prominent range collapsing", () => {
  it("merges contiguous prominent windows and keeps the peak", () => {
    const ranges = collapseProminentRanges(
      evidenceWith({
        windows: [
          { startSec: 0, rmsDb: -20, prominent: false },
          { startSec: 0.5, rmsDb: -16, prominent: true },
          { startSec: 1, rmsDb: -14, prominent: true },
          { startSec: 1.5, rmsDb: -22, prominent: false },
          { startSec: 2, rmsDb: -15, prominent: true },
        ],
      })
    );

    expect(ranges).toEqual([
      { startSec: 0.5, endSec: 1.5, peakDb: -14 },
      { startSec: 2, endSec: 2.5, peakDb: -15 },
    ]);
  });
});

describe("prompt formatting", () => {
  it("renders M:SS.s timestamps", () => {
    expect(formatTimestamp(0)).toBe("0:00.0");
    expect(formatTimestamp(9.46)).toBe("0:09.5");
    expect(formatTimestamp(63.1)).toBe("1:03.1");
  });

  it("states that a loud stretch is evidence about volume, not emphasis", () => {
    // The single most likely way this design fails is a prompt that turns the
    // model into a rubber stamp on the RMS series, so the caveat is asserted.
    const text = formatAcousticsForPrompt(
      evidenceWith({
        pauses: [{ startSec: 11.7, endSec: 11.95, durationSec: 0.25 }],
        windows: [{ startSec: 0, rmsDb: -16, prominent: true }],
      })
    );

    expect(text).toContain("0:11.7 to 0:11.9");
    expect(text).toContain("ffmpeg, not by a model");
  });

  it("says so explicitly when nothing was measured, rather than printing an empty list", () => {
    const text = formatAcousticsForPrompt(evidenceWith({}));

    expect(text).toContain("None detected");
    expect(text).toContain("even level throughout");
  });
});

describe("corroboration", () => {
  const analysisWith = (
    emphasisTerm: string,
    startSec: number,
    endSec: number
  ): Analysis =>
    Analysis.parse({
      sourceLanguage: "en",
      topic: "test",
      audience: "test",
      segments: [
        {
          id: "s01",
          startSec,
          endSec,
          text: "some spoken text",
          signal: "key_term",
          signalConfidence: 0.8,
          signalEvidence: "the speaker names the term",
          register: "neutral",
          pace: "normal",
          emphasis: [{ term: emphasisTerm, strength: "strong", evidence: "louder" }],
          idioms: [],
          keyTerms: [],
        },
      ],
    });

  it("supports a claim that sits inside a measured energy rise", () => {
    const report = corroborate(
      analysisWith("idempotent", 0, 6),
      evidenceWith({
        windows: [
          { startSec: 0, rmsDb: -20, prominent: false },
          { startSec: 2, rmsDb: -14, prominent: true },
        ],
      })
    );

    expect(report.supported).toBe(1);
    expect(report.emphasisChecks[0]?.measurement).toContain("Energy rise");
  });

  it("supports a claim closed by a pause even with no energy rise", () => {
    const report = corroborate(
      analysisWith("idempotent", 0, 6),
      evidenceWith({ pauses: [{ startSec: 6.2, endSec: 6.7, durationSec: 0.5 }] })
    );

    expect(report.supported).toBe(1);
    expect(report.emphasisChecks[0]?.measurement).toContain("let that land");
  });

  it("marks a claim unsupported when nothing was measured under it", () => {
    const report = corroborate(analysisWith("idempotent", 0, 6), evidenceWith({}));

    expect(report.unsupported).toBe(1);
    // The verdict must not overclaim: this pass measures level and silence, so
    // an unsupported claim may still be right by pitch.
    expect(report.emphasisChecks[0]?.measurement).toContain("pitch");
  });

  it("refuses to score a span shorter than one energy window", () => {
    const report = corroborate(analysisWith("idempotent", 0, 0.3), evidenceWith({}));

    expect(report.notMeasurable).toBe(1);
    expect(report.unsupported).toBe(0);
  });

  it("counts boundaries landing near a real pause, at either edge", () => {
    const report = corroborate(
      analysisWith("x", 0, 11.8),
      evidenceWith({ pauses: [{ startSec: 11.7, endSec: 11.95, durationSec: 0.25 }] })
    );

    // 0 is nowhere near a pause; 11.8 is 0.1s from one starting at 11.7.
    expect(report.boundariesTotal).toBe(2);
    expect(report.boundariesAligned).toBe(1);
  });
});

describe("the saved fixture output", () => {
  const expectedPath = "fixtures/analysis.expected.json";

  it.skipIf(!fs.existsSync(expectedPath))(
    "still parses against the current Analysis schema",
    () => {
      // Gitignored (it transcribes third-party audio), so this is skipped on a
      // fresh clone and on CI. Where it exists it catches the case where a
      // schema edit silently invalidates the accepted run.
      const saved: unknown = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
      const parsed = Analysis.parse((saved as { analysis: unknown }).analysis);

      expect(parsed.segments.length).toBeGreaterThan(0);
    }
  );
});
