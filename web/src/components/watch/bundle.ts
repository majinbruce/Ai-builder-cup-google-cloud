import type {
  AdaptedSegment,
  AnalyzedSegment,
  EmphasisCheck,
  Job,
  JobStatus,
  ModelCall,
  SegmentCritique,
  SynthesizedSegment,
  SynthesizedUtterance,
} from "@/lib/api/schemas";

/**
 * ============================================================================
 * One record per segment, joined from the job's four stage artifacts.
 * ============================================================================
 *
 * Everything the watch page shows is data already in the Job; these functions
 * only line it up by segment id and map times between the two tracks.
 */

/** Whole-clip calls, shown with every segment as shared cost. */
const SHARED_STAGES: ModelCall["stage"][] = ["analyze", "brief", "critique"];

export interface OutputWindow {
  startSec: number;
  lengthSec: number;
  sourceStartSec: number;
  sourceEndSec: number;
}

export interface SegmentBundle {
  source: AnalyzedSegment;
  adapted: AdaptedSegment | undefined;
  critique: SegmentCritique | undefined;
  synth: SynthesizedSegment | undefined;
  /** The TTS call this segment was spoken in. Undefined on jobs from before 2026-10-01. */
  utterance: SynthesizedUtterance | undefined;
  /**
   * The stretch of output.mp3 that voices this segment, and the source stretch
   * it covers. On newer jobs that is the whole utterance — a segment spoken
   * mid-sentence has no audio boundary of its own to seek to.
   */
  output: OutputWindow | undefined;
  checks: EmphasisCheck[];
  retried: boolean;
  /** The calls that produced THIS segment's adaptation (adapt, and a retry). */
  ownCalls: ModelCall[];
  /** Whole-clip calls (analyze, brief, critique) that every segment shares. */
  sharedCalls: ModelCall[];
}

/**
 * For a failed job, the stage it failed in — inferred from which artifacts
 * made it onto the row, since each stage writes its own the moment it ends.
 */
export function failedAt(job: Job): JobStatus {
  if (job.analysis === null) return "analyzing";
  if (job.adaptation === null) return "adapting";
  if (job.synthesis === null && job.critique === null) return "critiquing";
  return "synthesizing";
}

/**
 * Joins the four stage artifacts into one record per segment, by id.
 *
 * Per-segment call attribution follows the order the API writes `calls`:
 * analyze, brief, one adapt per segment in segment order, critique, then one
 * adapt_retry per retried segment in `retriedIds` order.
 */
export function bundle(job: Job): SegmentBundle[] {
  const { analysis, adaptation, critique, synthesis, corroboration } = job;
  if (analysis === null) return [];

  const adaptCalls = job.calls.filter((call) => call.stage === "adapt");
  const retryCalls = job.calls.filter((call) => call.stage === "adapt_retry");
  const sharedCalls = job.calls.filter((call) => SHARED_STAGES.includes(call.stage));
  const retried = job.retriedIds ?? [];

  const sourceById = new Map(analysis.segments.map((segment) => [segment.id, segment]));
  const windows = new Map<string, OutputWindow>();
  const utterances = synthesis?.utterances;

  if (utterances !== undefined) {
    // Each utterance sits at a measured place on the output timeline; every
    // segment in it plays the whole utterance.
    for (const utterance of utterances) {
      const first = sourceById.get(utterance.segmentIds[0] ?? "");
      const last = sourceById.get(utterance.segmentIds.at(-1) ?? "");
      if (first === undefined || last === undefined) continue;
      // A take cut into phrases, a later one held for the teacher, runs to its
      // last phrase's end: longer than the take, and the length to play.
      const lastPhrase = utterance.phrases?.at(-1);
      const lengthSec =
        lastPhrase === undefined
          ? utterance.measuredDurationSec
          : lastPhrase.startSec + lastPhrase.durationSec - utterance.outputStartSec;
      for (const id of utterance.segmentIds) {
        windows.set(id, {
          startSec: utterance.outputStartSec,
          lengthSec,
          sourceStartSec: first.startSec,
          sourceEndSec: last.endSec,
        });
      }
    }
  } else {
    // Jobs from before 2026-10-01: one call per segment, butt-joined.
    let offset = 0;
    for (const segment of synthesis?.segments ?? []) {
      const length = segment.measuredDurationSec ?? 0;
      windows.set(segment.id, {
        startSec: offset,
        lengthSec: length,
        sourceStartSec: segment.startSec,
        sourceEndSec: segment.endSec,
      });
      offset += length;
    }
  }

  return analysis.segments.map((source, index) => {
    const synth = synthesis?.segments.find((segment) => segment.id === source.id);
    const retryIndex = retried.indexOf(source.id);
    const ownCalls = [
      adaptCalls[index],
      retryIndex === -1 ? undefined : retryCalls[retryIndex],
    ].filter((call): call is ModelCall => call !== undefined);

    return {
      source,
      adapted: adaptation?.segments.find((segment) => segment.id === source.id),
      critique: critique?.segments.find((segment) => segment.id === source.id),
      synth,
      utterance:
        synth?.utterance === undefined ? undefined : utterances?.[synth.utterance],
      output: windows.get(source.id),
      checks: (corroboration?.emphasisChecks ?? []).filter(
        (check) => check.segmentId === source.id
      ),
      retried: retryIndex !== -1,
      ownCalls,
      sharedCalls,
    };
  });
}

/**
 * Where a playhead on either track falls, as a segment and a position in
 * SOURCE time. The Hindi for a stretch of source runs longer or shorter than
 * it, so its position is mapped proportionally into the source stretch it
 * adapts — which is what lets one lesson map carry a playhead for both.
 */
export function locate(
  segments: SegmentBundle[],
  track: "source" | "output",
  sec: number
): { id: string; sourceSec: number } | null {
  if (track === "source") {
    // A segment ends where the teacher stops and the next starts where they
    // start again, so there is a pause between the two. The playhead there
    // still belongs to the segment just heard, and before the first word to
    // the first: it must not vanish every time the teacher takes a breath.
    let index = 0;
    for (let i = 1; i < segments.length; i += 1) {
      if (sec >= (segments[i]?.source.startSec ?? Infinity)) index = i;
    }
    const entry = segments[index];
    if (entry === undefined) return null;
    const until = segments[index + 1]?.source.startSec ?? entry.source.endSec;
    return sec < until ? { id: entry.source.id, sourceSec: sec } : null;
  }

  for (const entry of segments) {
    const span = entry.output;
    if (span === undefined || span.lengthSec <= 0) continue;
    if (sec >= span.startSec && sec < span.startSec + span.lengthSec) {
      const fraction = (sec - span.startSec) / span.lengthSec;
      const sourceSec =
        span.sourceStartSec + fraction * (span.sourceEndSec - span.sourceStartSec);
      // A window can span several segments; the playhead belongs to the one
      // whose source time it maps into.
      const owner = segments.find(
        (other) => sourceSec >= other.source.startSec && sourceSec < other.source.endSec
      );
      return { id: (owner ?? entry).source.id, sourceSec };
    }
  }
  return null;
}

