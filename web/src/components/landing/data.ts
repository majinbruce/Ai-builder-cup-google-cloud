import type { Job, PedagogicalSignal } from "@/lib/api/schemas";

/** One stretch of the lecture: what the teacher was doing, and for how long. */
export interface LessonBand {
  signal: PedagogicalSignal;
  startSec: number;
  /** Until the next segment starts, so the strip has no gaps for the pauses. */
  spanSec: number;
}

export interface LessonShape {
  topic: string;
  durationSec: number;
  bands: LessonBand[];
}

/** A word of the specimen paragraph, and who says it was stressed. */
export interface SpecimenPart {
  text: string;
  /** The model says it heard stress here. */
  claimed: boolean;
  /** ffmpeg's loudness or pause measurement backs that up. */
  measured: boolean;
}

export interface MeasuredStats {
  /** What the counts below are out of: segments for a real job. */
  total: number;
  unit: string;
  /** Where the model claimed a stressed word. */
  claimed: number;
  /** Where a loudness or pause measurement backs that claim up. */
  measured: number;
  specimen: SpecimenPart[];
}

/**
 * The designer's sample of the demo lecture, shown until a demo job is
 * promoted (`npm run localize:promote-demo`); a promoted job's own analysis
 * and corroboration replace both.
 */
const SAMPLE_BANDS: [PedagogicalSignal, number][] = [
  ["transition", 24.1],
  ["example", 21.1],
  ["emphasis_shift", 10.9],
  ["recap", 12],
  ["definition", 10.2],
  ["example", 20.1],
  ["emphasis_shift", 10.9],
  ["transition", 5.5],
];

export const SAMPLE_SHAPE: LessonShape = {
  topic: "The Brachistochrone problem and the path of fastest descent under gravity",
  durationSec: 63,
  bands: SAMPLE_BANDS.reduce<LessonBand[]>((bands, [signal, weight]) => {
    const total = SAMPLE_BANDS.reduce((sum, [, w]) => sum + w, 0);
    const startSec = bands.reduce((sum, band) => sum + band.spanSec, 0);
    return [...bands, { signal, startSec, spanSec: (weight / total) * 63 }];
  }, []),
};

/** [text, was stress claimed, was it measured] */
const SAMPLE_WORDS: [string, boolean, boolean][] = [
  ["Gravity", true, true], [" is the ", false, false], ["force", true, true],
  [" that ", false, false], ["attracts two bodies toward", true, false],
  [" each other. The ", false, false], ["heavier", true, true],
  [" the bodies, the ", false, false], ["stronger", true, false], [" the ", false, false],
  ["pull", true, true], [". And ", false, false], ["distance", true, true],
  [" matters ", false, false], ["even more", true, false], [": ", false, false],
  ["double", true, true], [" the distance, and the pull falls to a ", false, false],
  ["quarter", true, true], [". That is why the ", false, false], ["Moon", true, false],
  [" stays in ", false, false], ["orbit", true, false], [" instead of ", false, false],
  ["falling", true, false], [" to Earth, and why the ", false, false],
  ["tides", true, true], [" rise twice a day.", false, false],
];

export const SAMPLE_STATS: MeasuredStats = {
  total: 19,
  unit: "key moments",
  claimed: 16,
  measured: 10,
  specimen: SAMPLE_WORDS.map(([text, claimed, measured]) => ({ text, claimed, measured })),
};

export function lessonShape(job: Job): LessonShape | null {
  const segments = job.analysis?.segments ?? [];
  const last = segments.at(-1);
  if (job.analysis === null || last === undefined) return null;

  return {
    topic: job.analysis.topic,
    durationSec: job.sourceDurationSec ?? last.endSec,
    bands: segments.map((segment, index) => ({
      signal: segment.signal,
      startSec: segment.startSec,
      spanSec: (segments[index + 1]?.startSec ?? segment.endSec) - segment.startSec,
    })),
  };
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What the model claimed about stress against what the recording shows, from
 * the job's corroboration: the counts, and one segment as a specimen — the one
 * with the most claims, preferring one where measurement disagreed with the
 * model at least once, since that is the point being made.
 */
export function measuredStats(job: Job): MeasuredStats | null {
  const segments = job.analysis?.segments ?? [];
  const checks = job.corroboration?.emphasisChecks ?? [];
  if (segments.length === 0 || checks.length === 0) return null;

  const bySegment = segments.map((segment) => ({
    segment,
    checks: checks.filter((check) => check.segmentId === segment.id),
  }));
  const claimed = bySegment.filter((entry) => entry.checks.length > 0);
  const measured = claimed.filter((entry) =>
    entry.checks.some((check) => check.verdict === "supported")
  );

  const rank = (entry: (typeof claimed)[number]) => {
    const mixed =
      entry.checks.some((check) => check.verdict === "supported") &&
      entry.checks.some((check) => check.verdict !== "supported");
    return entry.checks.length + (mixed ? 100 : 0);
  };
  const pick = [...claimed].sort((a, b) => rank(b) - rank(a))[0];
  if (pick === undefined) return null;

  const terms = [...pick.checks]
    .map((check) => check.term)
    .filter((term) => term.trim() !== "")
    .sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const specimen = pick.segment.text
    .split(pattern)
    .filter((part) => part !== "")
    .map((part) => {
      const check = pick.checks.find(
        (entry) => entry.term.toLowerCase() === part.toLowerCase()
      );
      return {
        text: part,
        claimed: check !== undefined,
        measured: check?.verdict === "supported",
      };
    });

  return {
    total: segments.length,
    unit: "segments",
    claimed: claimed.length,
    measured: measured.length,
    specimen,
  };
}
