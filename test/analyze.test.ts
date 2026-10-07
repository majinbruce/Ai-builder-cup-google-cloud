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
import { assertSegmentIds } from "../src/modules/localize/analyze.stage.ts";
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

  it("falls back to the last rung over the band, cut to its longest pauses", async () => {
    // Measured shape of a speaker who clips every phrase: over the band at
    // every rung. The old rule kept the LARGEST list, a pause every 1.25 s.
    const byThreshold = new Map([
      [-20.4, 48],
      [-22.4, 47],
      [-24.4, 47],
      [-28.4, 46],
      [-32.4, 44],
      [-36.4, 36],
      [-40.4, 20],
    ]);

    const result = await chooseSilenceThreshold(-16.4, 60, (thresholdDb) =>
      Promise.resolve(
        Array.from({ length: byThreshold.get(thresholdDb) ?? 0 }, (_, i) => ({
          startSec: i * 2,
          endSec: i * 2 + 0.2 + i * 0.01,
          durationSec: 0.2 + i * 0.01,
        }))
      )
    );

    expect(result.offsetDb).toBe(24);
    // 15 a minute is the top of the band; the five shortest are dropped.
    expect(result.pauses).toHaveLength(15);
    expect(result.pauses[0]?.startSec).toBe(10);
    expect(result.pauses.map((p) => p.startSec)).toEqual(
      [...result.pauses.map((p) => p.startSec)].sort((x, y) => x - y)
    );
  });

  it("keeps the dense rung, trimmed, when the band is jumped over", async () => {
    const byThreshold = new Map([
      [-20.4, 36],
      [-22.4, 34],
      [-24.4, 31],
      [-28.4, 27],
      [-32.4, 21],
      [-36.4, 4],
      [-40.4, 0],
    ]);

    const result = await chooseSilenceThreshold(-16.4, 60, (thresholdDb) =>
      Promise.resolve(silencesOfLength(byThreshold.get(thresholdDb) ?? 0))
    );

    expect(result.offsetDb).toBe(16);
    expect(result.pauses).toHaveLength(15);
  });

  it("keeps the rung that found the most when every rung is under the band", async () => {
    const result = await chooseSilenceThreshold(-16.4, 60, (thresholdDb) =>
      Promise.resolve(silencesOfLength(thresholdDb === -20.4 ? 3 : 1))
    );

    expect(result.pauses).toHaveLength(3);
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
    // Rounding carries into the minute instead of printing "0:60.0".
    expect(formatTimestamp(59.97)).toBe("1:00.0");
    expect(formatTimestamp(119.96)).toBe("2:00.0");
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
    // Energy support is the non-circular kind and is counted separately.
    expect(report.supportedByEnergy).toBe(1);
    expect(report.supportedByPauseOnly).toBe(0);
  });

  it("supports a claim closed by a pause even with no energy rise", () => {
    const report = corroborate(
      analysisWith("idempotent", 0, 6),
      evidenceWith({ pauses: [{ startSec: 6.2, endSec: 6.7, durationSec: 0.5 }] })
    );

    expect(report.supported).toBe(1);
    expect(report.emphasisChecks[0]?.measurement).toContain("let that land");
    // Still supported, but booked to the branch that carries circularity risk:
    // the prompt tells the model to cut at pauses, so this is weaker evidence.
    expect(report.supportedByEnergy).toBe(0);
    expect(report.supportedByPauseOnly).toBe(1);
  });

  it("checks a timed term against the second around it, not the whole segment", () => {
    const timed = (atSec: number): Analysis => {
      const analysis = analysisWith("idempotent", 0, 10);
      const marker = analysis.segments[0]?.emphasis[0];
      if (marker !== undefined) marker.atSec = atSec;
      return analysis;
    };
    const evidence = evidenceWith({
      windows: [
        { startSec: 2, rmsDb: -14, prominent: true },
        { startSec: 8, rmsDb: -20, prominent: false },
      ],
      pauses: [{ startSec: 4, endSec: 4.5, durationSec: 0.5 }],
    });

    // The rise at 2.0-2.5 s and the pause at 4 s are both inside the segment.
    expect(corroborate(timed(2.4), evidence).supportedByEnergy).toBe(1);
    expect(corroborate(timed(8), evidence).unsupported).toBe(1);
    // A timestamp outside its own segment is not trusted over the span.
    expect(corroborate(timed(40), evidence).supported).toBe(1);
  });

  it("takes the prominence median over speech, not over the silences too", () => {
    const windows = [-60, -60, -60, -20, -20, -16].map((rmsDb, i) => ({
      startSec: i * 0.5,
      rmsDb,
    }));

    expect(markProminence(windows).marked.filter((w) => w.prominent)).toHaveLength(3);
    expect(markProminence(windows, -40).marked.filter((w) => w.prominent)).toHaveLength(
      1
    );
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

  /** Two contiguous segments cut at `cutSec`, so there is exactly one boundary. */
  const twoSegmentsCutAt = (cutSec: number, endSec: number): Analysis =>
    Analysis.parse({
      sourceLanguage: "en",
      topic: "test",
      audience: "test",
      segments: [0, 1].map((index) => ({
        id: `s0${index + 1}`,
        startSec: index === 0 ? 0 : cutSec,
        endSec: index === 0 ? cutSec : endSec,
        text: "some spoken text",
        signal: "key_term",
        signalConfidence: 0.8,
        signalEvidence: "the speaker names the term",
        register: "neutral",
        pace: "normal",
        emphasis: [],
        idioms: [],
        keyTerms: [],
      })),
    });

  it("counts boundaries landing near a real pause, at either edge", () => {
    const report = corroborate(
      twoSegmentsCutAt(11.8, 20),
      evidenceWith({ pauses: [{ startSec: 11.7, endSec: 11.95, durationSec: 0.25 }] })
    );

    // The single interior cut at 11.8 is 0.1s from a pause starting at 11.7.
    expect(report.boundariesTotal).toBe(1);
    expect(report.boundariesAligned).toBe(1);
  });

  it("counts a shared boundary once, not once per adjoining segment", () => {
    const report = corroborate(twoSegmentsCutAt(11.8, 20), evidenceWith({}));

    // Segment 1 ends at 11.8 and segment 2 starts at 11.8: one decision.
    expect(report.boundariesTotal).toBe(1);
  });

  it("excludes the clip's own start and end from the boundary denominator", () => {
    // A single segment spans the whole clip and cuts nothing, so there is no
    // boundary to judge. Counting 0.0 and the duration here is what turned 4 of
    // 8 real alignments into a reported 8/18 on the first live run.
    const report = corroborate(analysisWith("x", 0, 11.8), evidenceWith({}));

    expect(report.boundariesTotal).toBe(0);
    expect(report.boundariesAligned).toBe(0);
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

describe("segment ids from the model", () => {
  const withIds = (...ids: string[]): Analysis => {
    const base = Analysis.parse(
      (
        JSON.parse(fs.readFileSync("fixtures/analysis.expected.json", "utf8")) as {
          analysis: unknown;
        }
      ).analysis
    );
    const template = base.segments[0];
    if (template === undefined) throw new Error("fixture has no segments");
    return { ...base, segments: ids.map((id) => ({ ...template, id })) };
  };

  it("accepts unique short ids", () => {
    expect(() => assertSegmentIds(withIds("s01", "s02", "s03"))).not.toThrow();
  });

  /** Every later stage joins on the id; a duplicate pairs the wrong texts silently. */
  it("refuses a duplicate id", () => {
    expect(() => assertSegmentIds(withIds("s01", "s02", "s01"))).toThrow(
      /more than once/
    );
  });

  it("refuses an id that is not a short alphanumeric token", () => {
    expect(() => assertSegmentIds(withIds("s01", "../s02"))).toThrow(/not a short/);
  });
});
