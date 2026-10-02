import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { concatAudio, encodeMp3, probeDurationSec } from "../../lib/ffmpeg.ts";
import { TTS_VOICE, clampSpeakingRate, synthesize } from "../../lib/tts.ts";
import { readPcmFormat, silenceWav } from "../../lib/wav.ts";
import { countSpokenChars, findLatinRuns } from "./drift.ts";
import { Synthesis } from "./localize.schemas.ts";
import type {
  Adaptation,
  AdaptedSegment,
  Analysis,
  AnalyzedSegment,
  SynthesizedSegment,
  SynthesizedUtterance,
} from "./localize.schemas.ts";

/**
 * ============================================================================
 * Stage 4 of docs/SPEC.md section b — the teacher's delivery, rebuilt.
 * ============================================================================
 *
 * Stage 1 measured where the speaker paused and what they leaned on; stage 2
 * decided, per segment, a `speakingRate` and a `pauseBefore`. This stage turns
 * those into Chirp 3 HD audio laid on the SOURCE timeline, so the Hindi is as
 * long as the English and in step with the video it will play over.
 *
 * The split mirrors lib/ffmpeg.ts vs acoustics.ts: lib/tts.ts returns bytes,
 * and every decision about what to send and where to put it is a pure, exported,
 * unit-tested function here (groupIntoUtterances, planFit, placeOnTimeline).
 *
 * WHAT CHIRP 3 HD HONOURS (Phase 3 spike, docs/research.md): `speaking_rate`
 * (0.85 -> +17.2%) and `<break time>`; inline `<prosody>`/`<emphasis>` are
 * accepted, ignored, and insert ~1.4 s of dead time each.
 *
 * WHAT CHANGED ON 2026-10-01, from listening to the deployed demo. Two things
 * were audible, and both came from treating a pedagogical segment as a unit of
 * speech:
 *
 *   1. Segment ends sounded final. Each segment was its own TTS request, and
 *      Chirp 3 HD speaks every request as a complete utterance — so a segment
 *      that ends mid-sentence on a comma got a full stop's falling ending, and
 *      the next request restarted from a neutral voice.
 *   2. An inline `<break>` did the same thing mid-segment. The 150 ms pause this
 *      stage placed before one emphasized term per segment came out as a
 *      0.64-1.07 s hole (silencedetect on the demo output) with the voice
 *      restarting after it; re-synthesizing without it removed the hole.
 *
 * Those holes and restarts were also most of the length overrun: 70.1 s of
 * Hindi for 62.6 s of English, where the text alone measures +1.2%.
 *
 * So: segments are grouped into UTTERANCES that end where a sentence ends; the
 * request is plain text with no tags; every pause is silence written here, where
 * its length is exact; and each utterance is fitted to the source time it
 * replaces — one faster re-take when it would run into the next one.
 */

/**
 * Pause lengths for `AdaptedSegment.ttsHints.pauseBefore`, in ms of silence.
 *
 * 350 ms is a clause boundary; 700 ms is the "here comes something" beat stage 1
 * detects before definitions and warnings. Inserted as silence between TTS calls
 * rather than as `<break>`, so the number is exactly what is heard.
 */
export const PAUSE_MS = { none: 0, short: 350, long: 700 } as const;

/**
 * The request ceiling per utterance, in UTF-8 bytes.
 *
 * Cloud TTS caps `input` at 5,000 bytes, and Devanagari is 3 bytes a character,
 * so ~1,650 characters. 4,000 leaves headroom and still holds a long sentence:
 * the fixture's longest group is ~650 bytes.
 */
export const MAX_UTTERANCE_BYTES = 4000;

/** An overrun this small is take-to-take noise (measured ±3%), not worth a re-take. */
export const FIT_TOLERANCE = 0.02;

/**
 * A re-take aims this far under its target, so noise in the second take lands it
 * inside the deadline rather than just past it.
 */
export const FIT_AIM = 0.97;

/**
 * The most a re-take may speed an utterance up, relative to the adapter's rate.
 *
 * Fifteen percent is roughly where a learner stops hearing "brisk" and starts
 * hearing "rushed". Past it, the overrun is kept and pushes later utterances
 * back: the output runs a little long rather than becoming hard to follow,
 * which would defeat the point of the pipeline. Capped absolutely at the top of
 * stage 2's own range as well.
 */
export const MAX_FIT_SPEEDUP = 1.15;
export const MAX_FIT_RATE = 1.3;

/** Sentence-final punctuation, allowing closing quotes or brackets after it. */
const SENTENCE_END = /[।॥?!.][\s"'”’)\]]*$/u;

export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trim());
}

export interface PlannedUtterance {
  index: number;
  segments: AdaptedSegment[];
  /** Exactly what is sent: the segments' Hindi, space-joined. */
  text: string;
  requestedRate: number;
  pauseBeforeMs: number;
  sourceStartSec: number;
}

/**
 * Groups consecutive segments into the units actually spoken. Pure.
 *
 * A new utterance starts when the previous segment ended a sentence, when this
 * segment asks for a pause (the pause sits between calls, where it is exact, and
 * the teacher's beat is a natural place to breathe), or when adding it would pass
 * MAX_UTTERANCE_BYTES.
 *
 * The rate is the adapter's per-segment rates weighted by source span: a 2 s
 * aside at 1.1 should not pull a 10 s definition at 0.85 halfway up.
 */
export function groupIntoUtterances(
  segments: readonly AdaptedSegment[],
  sourceById: ReadonlyMap<string, AnalyzedSegment>
): PlannedUtterance[] {
  const groups: AdaptedSegment[][] = [];
  let current: AdaptedSegment[] = [];
  let bytes = 0;

  for (const segment of segments) {
    const previous = current.at(-1);
    const segmentBytes = Buffer.byteLength(segment.targetText, "utf8") + 1;
    const startsNew =
      previous === undefined ||
      endsSentence(previous.targetText) ||
      segment.ttsHints.pauseBefore !== "none" ||
      bytes + segmentBytes > MAX_UTTERANCE_BYTES;

    if (startsNew && current.length > 0) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(segment);
    bytes += segmentBytes;
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, index) => {
    const first = group[0] as AdaptedSegment;
    const spans = group.map((segment) => {
      const source = sourceById.get(segment.id);
      return source === undefined ? 0 : source.endSec - source.startSec;
    });
    const totalSpan = spans.reduce((total, span) => total + span, 0);
    const requestedRate =
      totalSpan === 0
        ? first.ttsHints.speakingRate
        : group.reduce(
            (total, segment, i) =>
              total + segment.ttsHints.speakingRate * (spans[i] ?? 0),
            0
          ) / totalSpan;

    return {
      index,
      segments: group,
      text: group.map((segment) => segment.targetText.trim()).join(" "),
      requestedRate: clampSpeakingRate(Math.round(requestedRate * 1000) / 1000),
      pauseBeforeMs: PAUSE_MS[first.ttsHints.pauseBefore],
      sourceStartSec: sourceById.get(first.id)?.startSec ?? 0,
    };
  });
}

/** One utterance as the timeline sees it. */
export interface TimelineSlot {
  sourceStartSec: number;
  deadlineSec: number;
  pauseBeforeMs: number;
  durationSec: number;
}

/**
 * Where each utterance goes in the output. Pure.
 *
 * An utterance starts at its source start, or — if the previous one ran long, or
 * its pause does not fit in the gap left — right after the previous one plus its
 * pause. It never starts EARLY: the Hindi for a slide is not spoken over the
 * previous slide.
 */
export function placeOnTimeline(slots: readonly TimelineSlot[]): {
  startSec: number[];
  endSec: number;
} {
  const startSec: number[] = [];
  let cursor = 0;
  for (const slot of slots) {
    const start = Math.max(slot.sourceStartSec, cursor + slot.pauseBeforeMs / 1000);
    startSec.push(start);
    cursor = start + slot.durationSec;
  }
  return { startSec, endSec: cursor };
}

/**
 * Which utterances need a faster re-take, and at what rate. Pure.
 *
 * Walks the timeline with first-take durations. An utterance that would end past
 * its deadline by more than FIT_TOLERANCE gets a rate that should land it at
 * FIT_AIM of the time it has — speaking_rate scales duration close to linearly
 * on this voice (0.85 measured +17.2%, against 1/0.85 = +17.6%) — capped by
 * MAX_FIT_SPEEDUP. Its EXPECTED duration then carries forward, so a refit early
 * in the clip is not double-counted against the next utterance.
 *
 * Returns null for an utterance that fits.
 */
export function planFit(
  slots: readonly TimelineSlot[],
  rates: readonly number[]
): (number | null)[] {
  let cursor = 0;
  return slots.map((slot, i) => {
    const rate = rates[i] ?? 1;
    const start = Math.max(slot.sourceStartSec, cursor + slot.pauseBeforeMs / 1000);
    const available = slot.deadlineSec - start;

    if (start + slot.durationSec <= slot.deadlineSec + available * FIT_TOLERANCE) {
      cursor = start + slot.durationSec;
      return null;
    }

    const wanted =
      available <= 0 ? Infinity : (rate * slot.durationSec) / (available * FIT_AIM);
    const fitRate = Math.min(wanted, rate * MAX_FIT_SPEEDUP, MAX_FIT_RATE);
    if (fitRate <= rate) {
      cursor = start + slot.durationSec;
      return null;
    }
    const rounded = Math.round(fitRate * 1000) / 1000;
    cursor = start + (slot.durationSec * rate) / rounded;
    return rounded;
  });
}

export interface SynthesizeInput {
  analysis: Analysis;
  adaptation: Adaptation;
  /** Where utterance WAVs and the final mp3 are written. */
  outDir: string;
  /**
   * The source clip's full length, which the output is padded to. Defaults to
   * the last segment's end, which loses only trailing silence.
   */
  sourceDurationSec?: number;
  voice?: string;
  onProgress?: (done: number, total: number) => void;
}

export interface SynthesizeOutput {
  synthesis: Synthesis;
  /** Per-utterance WAV paths (the kept take), in order. */
  utteranceFiles: string[];
}

/**
 * How many TTS calls are in flight at once. Calls are independent; four rather
 * than "all" because a 180 s clip is up to ~45 requests, and 45 at once is how a
 * per-minute quota gets found.
 */
export const SYNTH_CONCURRENCY = 4;

/**
 * Runs `task` over `items` with at most `limit` in flight, results in INPUT
 * order — the timeline is built in array order, so order is the requirement.
 */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  // Set by the first failure, so other workers stop starting (and billing)
  // calls for a run that has already failed.
  let failed = false;

  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index] as T, index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface Take {
  file: string;
  audio: Buffer;
  durationSec: number;
  speakingRate: number;
  billedChars: number;
  latencyMs: number;
}

/**
 * Synthesizes, fits and places every utterance, then joins and measures.
 *
 * Two rounds of calls: every utterance at its requested rate, then a faster
 * re-take of only those planFit() says miss their deadline. A re-take that comes
 * back no shorter than the first (Chirp 3 HD is generative; durations vary ±3%
 * take to take) is discarded and the first kept.
 */
export async function runSynthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
  const { analysis, adaptation, outDir, voice = TTS_VOICE, onProgress } = input;

  const sourceById = new Map<string, AnalyzedSegment>(
    analysis.segments.map((segment) => [segment.id, segment])
  );

  /**
   * Every segment is checked before ANY is sent. With calls in flight
   * concurrently, a check inside the task would let calls already dispatched
   * finish and bill while the run was failing anyway.
   */
  for (const adapted of adaptation.segments) {
    if (!sourceById.has(adapted.id)) {
      throw new Error(
        `No analyzed segment for "${adapted.id}", so it has no time range. The ` +
          "analysis and adaptation are from different runs."
      );
    }

    // The Devanagari-only rule is a synthesis constraint, so this is where it is
    // last enforceable: a hi-IN voice would silently mispronounce Latin script.
    const latin = findLatinRuns(adapted.targetText);
    if (latin.length > 0) {
      throw new Error(
        `Segment ${adapted.id} still contains Latin script after the retry gate: ` +
          `${latin.map((run) => `"${run.text}"`).join(", ")}. This string is about ` +
          "to be read by a hi-IN voice, where Latin script is an unverified " +
          "pronunciation risk (docs/SPEC.md section b)."
      );
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const utteranceDir = path.join(outDir, "utterances");
  fs.mkdirSync(utteranceDir, { recursive: true });

  const planned = groupIntoUtterances(adaptation.segments, sourceById);
  // The latest END, not the last segment's: segment order is the model's, and
  // a shorter last segment would cut the tail off the padded output.
  const lastEndSec = Math.max(...analysis.segments.map((segment) => segment.endSec));
  const sourceDurationSec = Math.max(input.sourceDurationSec ?? lastEndSec, lastEndSec);

  let done = 0;
  const take = async (
    utterance: PlannedUtterance,
    rate: number,
    label: string
  ): Promise<Take> => {
    const result = await synthesize({
      input: { mode: "text", content: utterance.text },
      voice,
      speakingRate: rate,
    });
    // Named by position, not by id: ids came from the model, and a file name
    // built from one is a duplicate away from overwriting another.
    const file = path.join(
      utteranceDir,
      `${String(utterance.index).padStart(3, "0")}-${label}.wav`
    );
    fs.writeFileSync(file, result.audio);
    onProgress?.(++done, planned.length);
    return {
      file,
      audio: result.audio,
      durationSec: await probeDurationSec(file),
      speakingRate: result.speakingRate,
      billedChars: result.billedChars,
      latencyMs: result.latencyMs,
    };
  };

  const first = await mapBounded(planned, SYNTH_CONCURRENCY, (utterance) =>
    take(utterance, utterance.requestedRate, "a")
  );

  const slots = (durations: readonly number[]): TimelineSlot[] =>
    planned.map((utterance, i) => ({
      sourceStartSec: utterance.sourceStartSec,
      deadlineSec: planned[i + 1]?.sourceStartSec ?? sourceDurationSec,
      pauseBeforeMs: utterance.pauseBeforeMs,
      durationSec: durations[i] ?? 0,
    }));

  const fitRates = planFit(
    slots(first.map((entry) => entry.durationSec)),
    first.map((entry) => entry.speakingRate)
  );

  const refits = planned
    .map((utterance, i) => ({ utterance, rate: fitRates[i] ?? null }))
    .filter(
      (entry): entry is { utterance: PlannedUtterance; rate: number } =>
        entry.rate !== null
    );
  done = 0;
  const second = await mapBounded(refits, SYNTH_CONCURRENCY, ({ utterance, rate }) =>
    take(utterance, rate, "b")
  );
  const secondByIndex = new Map(
    refits.map((entry, i) => [entry.utterance.index, second[i]])
  );

  const kept = first.map((entry, i) => {
    const retake = secondByIndex.get(i);
    return retake !== undefined && retake.durationSec < entry.durationSec
      ? retake
      : entry;
  });

  const finalSlots = slots(kept.map((entry) => entry.durationSec));
  const placed = placeOnTimeline(finalSlots);

  /**
   * The join: silence up to each utterance's start, the utterance, and silence
   * to the source's end. Silence is written in the TTS output's own format, read
   * from its header, so the concat demuxer's `-c copy` stays a byte-level join.
   */
  const format = readPcmFormat((kept[0] as Take).audio);
  const parts: string[] = [];
  let cursor = 0;
  const gap = (sec: number, name: string) => {
    if (sec < 0.001) return;
    const file = path.join(utteranceDir, `${name}.silence.wav`);
    fs.writeFileSync(file, silenceWav(sec, format));
    parts.push(file);
  };
  kept.forEach((entry, i) => {
    const start = placed.startSec[i] ?? cursor;
    gap(start - cursor, `${String(i).padStart(3, "0")}`);
    parts.push(entry.file);
    cursor = start + entry.durationSec;
  });
  gap(sourceDurationSec - cursor, "tail");

  const joinedWav = path.join(outDir, "output.wav");
  const outputMp3 = path.join(outDir, "output.mp3");
  await concatAudio(parts, joinedWav);
  await encodeMp3(joinedWav, outputMp3, { normalizeLoudness: true });
  const durationSec = await probeDurationSec(outputMp3);

  const utterances: SynthesizedUtterance[] = planned.map((utterance, i) => {
    const firstTake = first[i] as Take;
    const keptTake = kept[i] as Take;
    const retake = secondByIndex.get(i);
    return {
      index: utterance.index,
      segmentIds: utterance.segments.map((segment) => segment.id),
      sourceStartSec: utterance.sourceStartSec,
      deadlineSec: finalSlots[i]?.deadlineSec ?? sourceDurationSec,
      markupUsed: utterance.text,
      inputMode: "text",
      requestedRate: utterance.requestedRate,
      speakingRate: keptTake.speakingRate,
      naturalDurationSec: firstTake.durationSec,
      measuredDurationSec: keptTake.durationSec,
      refit: keptTake !== firstTake,
      pauseBeforeMs: utterance.pauseBeforeMs,
      outputStartSec: placed.startSec[i] ?? 0,
      billedChars: firstTake.billedChars + (retake?.billedChars ?? 0),
      latencyMs: firstTake.latencyMs + (retake?.latencyMs ?? 0),
    };
  });

  const segments: SynthesizedSegment[] = planned.flatMap((utterance, i) =>
    utterance.segments.map((adapted) => {
      const source = sourceById.get(adapted.id) as AnalyzedSegment;
      const present = adapted.emphasisTerms.filter(
        (term) => term.trim() !== "" && adapted.targetText.includes(term)
      );
      return {
        id: adapted.id,
        startSec: source.startSec,
        endSec: source.endSec,
        voice,
        speakingRate: (utterances[i] as SynthesizedUtterance).speakingRate,
        markupUsed: utterance.text,
        inputMode: "text" as const,
        utterance: i,
        // Only the utterance's first segment can carry a pause: groupIntoUtterances
        // starts a new utterance at every segment that asks for one.
        pauseBeforeMs: PAUSE_MS[adapted.ttsHints.pauseBefore],
        emphasisNotFound: adapted.emphasisTerms.filter(
          (term) => !adapted.targetText.includes(term)
        ),
        // No inline pause any more: it restarted the voice (see the header).
        emphasisPausedTerm: null,
        emphasisNotRealized: present,
      };
    })
  );

  const spokenChars = adaptation.segments.reduce(
    (total, segment) => total + countSpokenChars(segment.targetText),
    0
  );
  const spokenSec = utterances.reduce(
    (total, utterance) => total + utterance.measuredDurationSec,
    0
  );

  const synthesis = Synthesis.parse({
    audioUri: outputMp3,
    durationSec,
    voice,
    segments,
    utterances,
    sourceDurationSec,
    billedChars: utterances.reduce(
      (total, utterance) => total + utterance.billedChars,
      0
    ),
    measuredCharsPerSec: spokenChars / spokenSec,
  });

  return { synthesis, utteranceFiles: kept.map((entry) => entry.file) };
}

/**
 * ============================================================================
 * The control: the same Hindi with none of our prosody.
 * ============================================================================
 *
 * The first real run reported the synthesized Hindi running 41.3% longer than
 * the English source span it has to cover. That number is true and, on its own,
 * it is not interpretable — it sums two unrelated causes:
 *
 *   1. the adapted text simply being too long for the span, which is a stage 2
 *      problem and means the character budget in adapt.v1.md is wrong; and
 *   2. the `<break>` leads and `<prosody rate="0.85">` wrappers that THIS stage
 *      adds on purpose, which are not drift at all — they are the product
 *      working, and they cost time by design.
 *
 * Attributing all of it to either cause would be wrong in a way that flatters
 * somebody. This function synthesizes each segment again as plain text at rate
 * 1.0, which isolates (1), so the difference between the two runs is (2).
 *
 * It is opt-in (`--baseline`) because it doubles the stage's bill, and it exists
 * because "our output is 41% too long" and "our output is 41% too long, of which
 * 8 points are pauses we chose to insert" are different claims and only one of
 * them is honest.
 */
export interface BaselineSegment {
  id: string;
  plainDurationSec: number;
  billedChars: number;
}

export interface BaselineReport {
  segments: BaselineSegment[];
  plainSec: number;
  billedChars: number;
  /** Spoken chars per second with no markup and no rate change — the clean value. */
  charsPerSec: number;
}

export async function measurePlainBaseline(
  adaptation: Adaptation,
  voice: string,
  onSegment?: (id: string, index: number, total: number) => void
): Promise<BaselineReport> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localize-tts-baseline-"));

  try {
    const segments: BaselineSegment[] = [];

    for (const [index, adapted] of adaptation.segments.entries()) {
      onSegment?.(adapted.id, index, adaptation.segments.length);

      const result = await synthesize({
        input: { mode: "text", content: adapted.targetText },
        voice,
        // Explicitly 1.0, not omitted: the control has to be the API's neutral
        // rate rather than whatever a future default change makes it.
        speakingRate: 1.0,
      });

      const file = path.join(dir, `${adapted.id}.wav`);
      fs.writeFileSync(file, result.audio);

      segments.push({
        id: adapted.id,
        plainDurationSec: await probeDurationSec(file),
        billedChars: result.billedChars,
      });
    }

    const plainSec = segments.reduce(
      (total, segment) => total + segment.plainDurationSec,
      0
    );
    const spokenChars = adaptation.segments.reduce(
      (total, segment) => total + countSpokenChars(segment.targetText),
      0
    );

    return {
      segments,
      plainSec,
      billedChars: segments.reduce((total, segment) => total + segment.billedChars, 0),
      charsPerSec: spokenChars / plainSec,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
