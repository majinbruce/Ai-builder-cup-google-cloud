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
  totalSegments: number;
  /** Segments where the model claimed at least one stressed word. */
  claimedSegments: number;
  /** Segments where at least one such claim was backed by a measurement. */
  measuredSegments: number;
  claimedWords: number;
  measuredWords: number;
  specimen: SpecimenPart[];
}

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
    totalSegments: segments.length,
    claimedSegments: claimed.length,
    measuredSegments: measured.length,
    claimedWords: checks.length,
    measuredWords: checks.filter((check) => check.verdict === "supported").length,
    specimen,
  };
}
