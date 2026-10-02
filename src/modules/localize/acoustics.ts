import {
  detectSilences,
  measureMeanVolumeDb,
  measureRmsWindows,
  probeDurationSec,
  type RmsWindow,
  type Silence,
} from "../../lib/ffmpeg.ts";
import type { AcousticEvidence, EnergyWindow } from "./localize.schemas.ts";

/**
 * ============================================================================
 * What the microphone actually recorded, as opposed to what the model says it
 * heard.
 * ============================================================================
 *
 * docs/JUDGE_NOTES.md records the gap this module exists to close. The Phase 0
 * smoke run came back describing "rhythmic pauses designed to prompt listener
 * reflection" — a claim that reads well and that the model could have produced
 * from the *meaning* of the passage without hearing a single change in volume.
 * The differentiator in docs/SPEC.md section a is that we detect how the
 * teacher DELIVERED the material, so a prosody claim we cannot check is the one
 * claim the project cannot afford to hand-wave.
 *
 * The measurements here serve two distinct purposes, and it matters that they
 * are the same numbers both times:
 *
 *   1. They go INTO the analyze prompt, so the model reasons with the pause and
 *      energy structure in front of it rather than guessing at it.
 *   2. They are held BACK for corroborate.ts, which scores what the model
 *      claimed against what was measured.
 *
 * ffmpeg's own output is parsed in lib/ffmpeg.ts. Everything in this file is
 * interpretation — choosing a threshold, deciding what "prominent" means — and
 * is deliberately separate so those decisions are readable and testable rather
 * than buried in a filter string.
 */

/**
 * Energy window width, seconds.
 *
 * 0.5 s is roughly one stressed syllable-group in connected speech: long enough
 * that a single plosive does not register as emphasis, short enough that one
 * loud word is not averaged away by the clause around it. 63.1 s of fixture
 * yields 127 windows at this width.
 */
const WINDOW_SEC = 0.5;

/** The pipeline normalizes every clip to 16 kHz mono; see docs/SPEC.md stage 0. */
const SAMPLE_RATE = 16_000;

/**
 * A window this far above the clip's median level is called prominent.
 *
 * 3 dB is a doubling of power and is about the smallest level change a listener
 * reliably notices. Lower and every vowel in the clip is "emphasis"; higher and
 * only shouting counts.
 */
const PROMINENCE_DB = 3;

/**
 * Silences shorter than this are the gaps inside normal speech — stop
 * consonants, breath — not pauses a teacher is using to mark something.
 */
const MIN_PAUSE_SEC = 0.2;

/**
 * The adaptive threshold ladder, in dB below the clip's own mean level.
 *
 * A fixed threshold is wrong for every clip it was not tuned on, and
 * fixtures/README.md records how that fails in practice: the raw source
 * averaged -45 dBFS, where any sane absolute threshold called the whole
 * recording silent. Measured on the normalized fixture (mean -16.4 dB): -33 dB
 * absolute finds 0 pauses, while mean-5.6 finds 11 — about one every 5.7 s,
 * which is a believable sentence-boundary density for a lecture.
 *
 * Tried in order, tightest first, stopping at the first threshold that produces
 * a plausible density. Ordering matters: a threshold that is too permissive
 * finds "pauses" mid-word, and once found they cannot be told apart from real
 * ones downstream.
 */
const THRESHOLD_LADDER_DB = [4, 6, 8, 12, 16];

/** Plausible pause density for speech: roughly one every 4-10 seconds. */
const MIN_PAUSES_PER_MINUTE = 6;
const MAX_PAUSES_PER_MINUTE = 15;

/** Below this, density is meaningless and the ladder just takes its best shot. */
const MIN_PAUSES_ABSOLUTE = 2;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1] ?? 0;
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 0 ? (lower + upper) / 2 : upper;
}

/**
 * Walks the ladder and returns the first threshold with a plausible pause
 * density, or the one that found the most pauses if none qualifies.
 *
 * Exported for the unit tests, which drive it with a canned detector rather
 * than an audio file — the point of the ladder is the decision rule, and that
 * should be provable without ffmpeg installed.
 */
export async function chooseSilenceThreshold(
  meanVolumeDb: number,
  durationSec: number,
  detect: (thresholdDb: number) => Promise<Silence[]>
): Promise<{ thresholdDb: number; offsetDb: number; pauses: Silence[] }> {
  const minutes = durationSec / 60;
  let best: { thresholdDb: number; offsetDb: number; pauses: Silence[] } | null = null;

  for (const offsetDb of THRESHOLD_LADDER_DB) {
    const thresholdDb = Math.round((meanVolumeDb - offsetDb) * 10) / 10;
    const pauses = await detect(thresholdDb);
    const perMinute = pauses.length / minutes;

    if (best === null || pauses.length > best.pauses.length) {
      best = { thresholdDb, offsetDb, pauses };
    }

    if (
      pauses.length >= MIN_PAUSES_ABSOLUTE &&
      perMinute >= MIN_PAUSES_PER_MINUTE &&
      perMinute <= MAX_PAUSES_PER_MINUTE
    ) {
      return { thresholdDb, offsetDb, pauses };
    }
  }

  // Unreachable with a non-empty ladder, but the type says it is possible.
  if (best === null) {
    throw new Error("The silence threshold ladder is empty.");
  }

  return best;
}

/** Marks windows at or above the clip median + PROMINENCE_DB. */
export function markProminence(windows: RmsWindow[]): {
  medianRmsDb: number;
  prominenceThresholdDb: number;
  marked: EnergyWindow[];
} {
  const medianRmsDb = median(windows.map((w) => w.rmsDb));
  const prominenceThresholdDb = medianRmsDb + PROMINENCE_DB;

  return {
    medianRmsDb: Math.round(medianRmsDb * 100) / 100,
    prominenceThresholdDb: Math.round(prominenceThresholdDb * 100) / 100,
    marked: windows.map((w) => ({
      startSec: w.startSec,
      rmsDb: Math.round(w.rmsDb * 100) / 100,
      prominent: w.rmsDb >= prominenceThresholdDb,
    })),
  };
}

/**
 * Measures one clip: duration, mean level, pauses, and the energy series.
 *
 * Four ffmpeg passes over a <= 180 s file. That is more decoding than strictly
 * necessary and it is the right trade for a hackathon: one combined filter
 * graph would save a second or two of wall clock and cost the ability to test
 * or reason about either measurement on its own.
 */
export async function measureAcoustics(audioPath: string): Promise<AcousticEvidence> {
  const [durationSec, meanVolumeDb] = await Promise.all([
    probeDurationSec(audioPath),
    measureMeanVolumeDb(audioPath),
  ]);

  const { thresholdDb, offsetDb, pauses } = await chooseSilenceThreshold(
    meanVolumeDb,
    durationSec,
    (candidate) => detectSilences(audioPath, candidate, MIN_PAUSE_SEC)
  );

  const rawWindows = await measureRmsWindows(audioPath, WINDOW_SEC, SAMPLE_RATE);
  const { medianRmsDb, prominenceThresholdDb, marked } = markProminence(rawWindows);

  return {
    durationSec: Math.round(durationSec * 1000) / 1000,
    meanVolumeDb,
    silenceThresholdDb: thresholdDb,
    thresholdOffsetDb: offsetDb,
    windowSec: WINDOW_SEC,
    medianRmsDb,
    prominenceThresholdDb,
    pauses: pauses.map((p) => ({
      startSec: Math.round(p.startSec * 1000) / 1000,
      endSec: Math.round(p.endSec * 1000) / 1000,
      durationSec: Math.round(p.durationSec * 1000) / 1000,
    })),
    windows: marked,
  };
}

/** Seconds as `M:SS.s`, the format the analyze prompt asks the model to use. */
export function formatTimestamp(seconds: number): string {
  // Rounded to tenths BEFORE splitting, or 59.97 prints as "0:60.0".
  const rounded = Number(seconds.toFixed(1));
  const minutes = Math.floor(rounded / 60);
  const rest = rounded - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/**
 * Renders the measurements as the text block that accompanies the audio.
 *
 * Two things are deliberate here. The pause list is complete, because pause
 * placement is exactly what segment boundaries should follow. The energy series
 * is NOT complete — sending 127 raw numbers would spend tokens teaching the
 * model to read a spreadsheet, and the useful signal is which stretches stand
 * out. Contiguous prominent windows are therefore collapsed into ranges.
 *
 * The header states what the numbers are and are not. docs/SPEC.md section g
 * warns that measurement could turn the model into a rubber stamp; a level rise
 * is evidence about VOLUME, and volume is not the same thing as instructional
 * emphasis. The prompt says so, and asks the model to disagree when it should.
 */
export function formatAcousticsForPrompt(evidence: AcousticEvidence): string {
  const lines: string[] = [];

  lines.push("## Measured acoustics for this clip");
  lines.push("");
  lines.push(
    `Produced by ffmpeg, not by a model. Duration ${evidence.durationSec.toFixed(1)}s, ` +
      `mean level ${evidence.meanVolumeDb.toFixed(1)} dBFS, median window level ` +
      `${evidence.medianRmsDb.toFixed(1)} dBFS over ${evidence.windowSec}s windows.`
  );
  lines.push("");

  lines.push(
    `### Silences (threshold ${evidence.silenceThresholdDb} dBFS = mean − ` +
      `${evidence.thresholdOffsetDb} dB, minimum ${MIN_PAUSE_SEC}s)`
  );
  lines.push("");

  if (evidence.pauses.length === 0) {
    lines.push("None detected. This clip has no measurable pauses.");
  } else {
    for (const pause of evidence.pauses) {
      lines.push(
        `- ${formatTimestamp(pause.startSec)} to ${formatTimestamp(pause.endSec)} ` +
          `(${pause.durationSec.toFixed(2)}s)`
      );
    }
  }
  lines.push("");

  lines.push(
    `### Louder stretches (window level at or above ${evidence.prominenceThresholdDb} dBFS, ` +
      `median + ${PROMINENCE_DB} dB)`
  );
  lines.push("");

  const ranges = collapseProminentRanges(evidence);

  if (ranges.length === 0) {
    lines.push("None. The clip is delivered at an even level throughout.");
  } else {
    for (const range of ranges) {
      lines.push(
        `- ${formatTimestamp(range.startSec)} to ${formatTimestamp(range.endSec)} ` +
          `(peak ${range.peakDb.toFixed(1)} dBFS)`
      );
    }
  }

  return lines.join("\n");
}

/** Contiguous prominent windows, merged into ranges with their peak level. */
export function collapseProminentRanges(
  evidence: AcousticEvidence
): Array<{ startSec: number; endSec: number; peakDb: number }> {
  const ranges: Array<{ startSec: number; endSec: number; peakDb: number }> = [];
  let open: { startSec: number; endSec: number; peakDb: number } | null = null;

  for (const window of evidence.windows) {
    if (!window.prominent) {
      if (open !== null) {
        ranges.push(open);
        open = null;
      }
      continue;
    }

    const end = window.startSec + evidence.windowSec;

    if (open === null) {
      open = { startSec: window.startSec, endSec: end, peakDb: window.rmsDb };
    } else {
      open.endSec = end;
      open.peakDb = Math.max(open.peakDb, window.rmsDb);
    }
  }

  if (open !== null) ranges.push(open);

  return ranges;
}
