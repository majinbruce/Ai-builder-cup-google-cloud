import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { concatAudio, encodeMp3, probeDurationSec } from "../../lib/ffmpeg.ts";
import {
  TTS_VOICE,
  clampSpeakingRate,
  synthesize,
  type TtsInput,
} from "../../lib/tts.ts";
import { countSpokenChars, findLatinRuns } from "./drift.ts";
import { Synthesis } from "./localize.schemas.ts";
import type {
  Adaptation,
  AdaptedSegment,
  Analysis,
  AnalyzedSegment,
  SynthesizedSegment,
} from "./localize.schemas.ts";

/**
 * ============================================================================
 * Stage 4 of docs/SPEC.md section b — the teacher's delivery, rebuilt.
 * ============================================================================
 *
 * This is the stage where three phases of annotation stop being JSON and become
 * something a learner can hear. Stage 1 measured where the speaker paused and
 * what they leaned on; stage 2 decided, per segment, a `speakingRate`, a
 * `pauseBefore` and a list of Hindi tokens carrying the stress. Everything below
 * turns those three fields into markup and sends it to Chirp 3 HD.
 *
 * The split mirrors lib/ffmpeg.ts vs acoustics.ts and lib/gemini.ts vs the other
 * stages: lib/tts.ts shells out and returns bytes, and every decision about WHAT
 * to say lives here as pure, exported, unit-tested functions. buildTtsInput()
 * takes no client and performs no I/O, because `markupUsed` in the audit panel
 * is a claim about a request and a test has to be able to read that request
 * without a credential.
 *
 * WHAT CHIRP 3 HD ACTUALLY HONOURS, and how much it cost to find out.
 *
 * docs/SPEC.md section b left this conditional — "SSML prosody if the Phase 3
 * spike confirms Chirp 3 HD honors it" — because Google documented three
 * different answers. src/scripts/spike-tts.ts settled it, but not on the first
 * try, and the wrong answer shipped into this file before the right one did.
 * The sequence is recorded because the mistake is instructive:
 *
 *   1. `<break time="3s"/>` added 3.71 s — a predicted magnitude, hit. Read as
 *      "SSML is honoured", and this stage was built wrapping every stressed term
 *      in `<prosody rate="0.85">`.
 *   2. That build made the fixture 41% longer than its source span. Two 350 ms
 *      breaks and sixteen rate wrappers cannot cost 24 seconds, so the number
 *      was not drift — it was a bug reporting itself.
 *   3. The no-op control found it. `<prosody rate="1.0">` asks for the rate the
 *      voice already uses and must therefore change nothing; it added 12.8%,
 *      as much as `rate="slow"` did. Two wrappers cost 1.69x one.
 *
 * So: Chirp 3 HD on hi-IN parses SSML STRUCTURE and ignores inline `<prosody>`'s
 * rate ATTRIBUTE. Each inline tag inserts roughly 1.4 s of dead time at its own
 * position, whatever it says. `<break>` appeared to work for the same reason
 * every other tag appeared to work — inserting time is simply what `<break>`
 * means, so for that one tag the artifact and the intent coincide.
 *
 * WHAT THIS STAGE THEREFORE USES, every element measured on this voice:
 *
 *   - segment rate: `audioConfig.speaking_rate` (rate 0.85 -> +17.2%, real).
 *   - pauses: `<break time>` (350 ms leading -> +0.30 s measured; accurate).
 *   - emphasis: a short `<break>` before ONE term per segment. See below.
 *
 * WHAT IT DELIBERATELY DOES NOT USE: inline `<prosody>` and `<emphasis>`, which
 * cannot stress a term on this voice and actively harm the audio by punching a
 * hole beside every word they touch; and `[pause short|long]` markup, which
 * docs/research.md listed as supported for hi-IN and which the spike measured
 * producing NO silence at all in the leading position (-2.8%, inside the noise
 * floor). research.md is corrected rather than worked around, per CLAUDE.md.
 */

/**
 * Pause lengths for `AdaptedSegment.ttsHints.pauseBefore`.
 *
 * Real numbers rather than SSML's named strengths because the spike measured
 * `<break time>` accurately enough to trust the number, and because a named
 * strength is the model's vocabulary while this is the pipeline's decision. 350
 * ms is a clause boundary; 700 ms is the "here comes something" beat that stage
 * 1 detects before definitions and warnings — comfortably above the 200 ms floor
 * acoustics.ts uses to tell a pedagogical pause from a stop consonant.
 */
export const PAUSE_MS = { none: 0, short: 350, long: 700 } as const;

/**
 * The pause placed before an emphasized term, in milliseconds requested.
 *
 * This is the ONE prosodic device available for marking a term on this voice,
 * and it is a real one: pausing immediately before a word is what a teacher does
 * when they want it to land ("and the answer is ... idempotent"). It is not the
 * same thing as stressing the word, and nothing in this pipeline says it is.
 *
 * 150 ms is what gets REQUESTED; the spike measured an inline break costing
 * roughly 0.59 s more than it asks for, so the audible beat is around 0.7 s.
 * Requesting the small number and reporting the measured one is the honest way
 * round: `markupUsed` shows what was asked, `measuredDurationSec` shows what
 * happened.
 *
 * ONE term per segment, not all of them. Two reasons, and neither is cost. A
 * speaker has one prosodic peak per breath group — marking four words in a
 * ten-second sentence is not emphasis, it is a stutter — and at ~0.7 s each,
 * sixteen of them added 37% to the fixture, which is the bug that started this
 * comment.
 */
export const EMPHASIS_PAUSE_MS = 150;

/** Escapes text for inclusion in an SSML document. */
export function escapeSsml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface BuiltTtsInput {
  input: TtsInput;
  speakingRate: number;
  /** Terms stage 2 asked to stress that do not occur in its own targetText. */
  emphasisNotFound: string[];
  /** The leading pause actually requested, in ms. Zero when pauseBefore is none. */
  pauseBeforeMs: number;
  /** The single term given a pause, or null when the segment had none usable. */
  emphasisPausedTerm: string | null;
  /**
   * Terms present in the Hindi that got no acoustic treatment at all.
   *
   * They are still highlighted in the reasoning panel, so this is not the same as
   * being discarded — but the audio does nothing for them, and a panel claiming
   * to show what was applied has to be able to say so.
   */
  emphasisNotRealized: string[];
}

/**
 * Builds the exact request for one segment. Pure; no client, no I/O.
 *
 * Order matters. The Hindi is XML-escaped ONCE, before any tag is inserted —
 * escaping afterwards would escape our own tags into literal text. Then the
 * emphasis break goes in, then the leading break.
 *
 * A term absent from `targetText` is collected into `emphasisNotFound` rather
 * than silently skipped: that is the adapter having claimed stress on a string it
 * did not write, and the CLI prints it.
 */
export function buildTtsInput(segment: AdaptedSegment): BuiltTtsInput {
  const { targetText, emphasisTerms, ttsHints } = segment;

  const emphasisNotFound = emphasisTerms.filter((term) => !targetText.includes(term));

  const present = emphasisTerms.filter(
    (term) => term.trim() !== "" && targetText.includes(term)
  );

  let body = escapeSsml(targetText);

  /**
   * The first present term gets the pause; the rest get nothing.
   *
   * First rather than longest or "strongest": stage 2 emits emphasisTerms in the
   * order it considered them, which tracks the order they occur in the sentence,
   * and the earliest one is the one a listener has not yet been given a reason to
   * expect. Strength would be the better criterion and is not available here —
   * `AnalyzedSegment.emphasis[].strength` describes the ENGLISH terms, and there
   * is no reliable mapping from those to the Hindi tokens stage 2 chose. Picking
   * on a criterion we do not have would be inventing one.
   */
  const paused = present[0] ?? null;

  if (paused !== null) {
    const escaped = escapeSsml(paused);
    // Only the first occurrence: a word said five times is not stressed five
    // times.
    body = body.replace(escaped, `<break time="${EMPHASIS_PAUSE_MS}ms"/>${escaped}`);
  }

  const pauseMs = PAUSE_MS[ttsHints.pauseBefore];
  const lead = pauseMs === 0 ? "" : `<break time="${pauseMs}ms"/>`;

  return {
    input: { mode: "ssml", content: `<speak>${lead}${body}</speak>` },
    speakingRate: clampSpeakingRate(ttsHints.speakingRate),
    pauseBeforeMs: pauseMs,
    emphasisNotFound,
    emphasisPausedTerm: paused,
    emphasisNotRealized: paused === null ? [] : present.slice(1),
  };
}

export interface SynthesizeInput {
  analysis: Analysis;
  adaptation: Adaptation;
  /** Where per-segment WAVs and the final mp3 are written. */
  outDir: string;
  voice?: string;
  onSegment?: (segment: AdaptedSegment, index: number, total: number) => void;
}

export interface SynthesizeOutput {
  synthesis: Synthesis;
  /** Per-segment WAV paths, kept so the UI can play one segment alone. */
  segmentFiles: string[];
}

/**
 * How many segments are synthesized at once.
 *
 * Phase 3 ran them one at a time on purpose, to get a readable per-segment
 * number first (1.4-2.6 s each, ~16 s for the fixture's eight). Unlike adapt,
 * these calls are genuinely independent — no segment's audio depends on
 * another's — so Phase 4 pulls the lever research.md left for it. Four rather
 * than "all": a 180 s clip is up to ~45 segments, and 45 simultaneous requests
 * is how a per-minute quota gets found.
 */
export const SYNTH_CONCURRENCY = 4;

/**
 * Runs `task` over `items` with at most `limit` in flight, results in INPUT
 * order. Order is the whole requirement: the concat below joins files in array
 * order, and a segment finishing early must not move in the lecture.
 */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Synthesizes every segment, joins them, and measures the result.
 *
 * Up to SYNTH_CONCURRENCY segments in flight; see the constant for why.
 * Each segment's `latencyMs` is still its own call's latency, so the
 * per-segment cost reads the same as in Phase 3 — only the wall clock changes.
 */
export async function runSynthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
  const { analysis, adaptation, outDir, voice = TTS_VOICE, onSegment } = input;

  const sourceById = new Map<string, AnalyzedSegment>(
    analysis.segments.map((segment) => [segment.id, segment])
  );

  fs.mkdirSync(outDir, { recursive: true });
  const segmentDir = path.join(outDir, "segments");
  fs.mkdirSync(segmentDir, { recursive: true });

  /**
   * Every segment is checked before ANY is sent. With calls in flight
   * concurrently, a check inside the task would let the segments already
   * dispatched finish and bill while the run was failing anyway.
   */
  for (const adapted of adaptation.segments) {
    const source = sourceById.get(adapted.id);
    if (source === undefined) {
      throw new Error(
        `No analyzed segment for "${adapted.id}", so it has no time range. The ` +
          "analysis and adaptation are from different runs."
      );
    }

    // The Devanagari-only rule is a synthesis constraint, so this is where it is
    // last enforceable. Phase 2's retry gate already sends Latin-script segments
    // back once; a segment that still has it at this point would be silently
    // mispronounced by a hi-IN voice, and the run should say so instead.
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

  const synthesized = await mapBounded(
    adaptation.segments,
    SYNTH_CONCURRENCY,
    (adapted, index) => synthesizeOne(adapted, index)
  );

  const segments = synthesized.map((entry) => entry.segment);
  const segmentFiles = synthesized.map((entry) => entry.file);

  async function synthesizeOne(
    adapted: AdaptedSegment,
    index: number
  ): Promise<{ segment: SynthesizedSegment; file: string }> {
    const source = sourceById.get(adapted.id) as AnalyzedSegment;

    onSegment?.(adapted, index, adaptation.segments.length);

    const built = buildTtsInput(adapted);

    const result = await synthesize({
      input: built.input,
      voice,
      speakingRate: built.speakingRate,
    });

    const file = path.join(segmentDir, `${adapted.id}.wav`);
    fs.writeFileSync(file, result.audio);

    const segment: SynthesizedSegment = {
      id: adapted.id,
      startSec: source.startSec,
      endSec: source.endSec,
      voice: result.voice,
      speakingRate: result.speakingRate,
      markupUsed: built.input.content,
      inputMode: built.input.mode,
      measuredDurationSec: await probeDurationSec(file),
      billedChars: result.billedChars,
      latencyMs: result.latencyMs,
      pauseBeforeMs: built.pauseBeforeMs,
      emphasisNotFound: built.emphasisNotFound,
      emphasisPausedTerm: built.emphasisPausedTerm,
      emphasisNotRealized: built.emphasisNotRealized,
    };

    return { segment, file };
  }

  const joinedWav = path.join(outDir, "output.wav");
  const outputMp3 = path.join(outDir, "output.mp3");

  await concatAudio(segmentFiles, joinedWav);
  await encodeMp3(joinedWav, outputMp3);

  const durationSec = await probeDurationSec(outputMp3);

  /**
   * Characters per second, measured rather than assumed.
   *
   * Divided by the summed SEGMENT durations, not by the final file's, so the
   * number describes speech rather than speech plus whatever the concat and the
   * mp3 encode contributed. Those two are compared separately in the CLI, where
   * a mismatch is a bug in the join rather than a fact about Hindi.
   */
  const spokenChars = adaptation.segments.reduce(
    (total, segment) => total + countSpokenChars(segment.targetText),
    0
  );
  const spokenSec = segments.reduce(
    (total, segment) => total + segment.measuredDurationSec,
    0
  );

  const synthesis = Synthesis.parse({
    audioUri: outputMp3,
    durationSec,
    voice,
    segments,
    billedChars: segments.reduce((total, segment) => total + segment.billedChars, 0),
    measuredCharsPerSec: spokenChars / spokenSec,
  });

  return { synthesis, segmentFiles };
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
