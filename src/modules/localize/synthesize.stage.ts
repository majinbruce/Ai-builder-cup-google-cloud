import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../../config/index.ts";
import {
  SPEECH_FORMAT,
  concatAudio,
  conformSpeech,
  encodeMp3,
  normalizeSpeechLoudness,
  probeDurationSec,
} from "../../lib/ffmpeg.ts";
import { GEMINI_TTS_MODEL, generateSpeech } from "../../lib/gemini.ts";
import { loadPrompt } from "../../lib/prompts.ts";
import {
  TTS_LANGUAGE_CODE,
  TTS_VOICE,
  clampSpeakingRate,
  synthesize,
} from "../../lib/tts.ts";
import { findQuietRuns, readMono16, silenceWav, sliceMono16 } from "../../lib/wav.ts";
import { MEASURED_CHARS_PER_SEC, countSpokenChars, findLatinRuns } from "./drift.ts";
import { Synthesis, TakePace } from "./localize.schemas.ts";
import type {
  Adaptation,
  AdaptedSegment,
  Analysis,
  AnalyzedSegment,
  MeasuredPause,
  Speaker,
  SynthesizedSegment,
  SynthesizedUtterance,
} from "./localize.schemas.ts";
import { castVoices, mainSpeaker } from "./speakers.ts";

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
 * replaces.
 *
 * WHAT CHANGED ON 2026-10-06, from listening to nine more clips. The Hindi was
 * right and sounded read out: Chirp 3 HD takes text and a rate and nothing
 * else, so everything stage 1 heard in the teacher stopped at this stage's
 * door. And sentences were landing behind the picture.
 *
 *   1. The voice is now Gemini TTS, which takes direction. Each utterance is
 *      sent with who the teacher is, what each part is doing, its mood, the
 *      words to lean on and how long it has (buildSpeechDirection). Chirp 3 HD
 *      in the same voice is the fallback for an utterance the Preview model
 *      fails.
 *   2. The fit is ffmpeg `atempo` on the take, not a second take at another
 *      rate: exact, free, and able to slow a short take as well as speed a long
 *      one.
 *   3. `pauseBefore` adds no silence. The teacher's pause is already on the
 *      source timeline; adding ours only ever made the next sentence late.
 *
 * WHAT CHANGED ON 2026-10-07, from watching the first videos voiced by
 * gemini-3.8-flash-tts: the teacher's lips moving, and nothing to hear. The
 * re-time in (2) can give a take back a tenth; a lecturer who takes half as
 * long again as the voice needs a different TAKE. So a take that cannot be
 * fitted is now recorded again at another pace, each is rehearsed against the
 * teacher's measured pauses, and the one that leaves the teacher speaking
 * unheard for least is kept. See "Pace", below.
 */

/**
 * Pause lengths for `AdaptedSegment.ttsHints.pauseBefore`, in ms of silence.
 *
 * Since 2026-10-06 this is the adapter's hint as REPORTED per segment and the
 * reason an utterance boundary is cut there; no silence of this length is
 * written (see placeOnTimeline).
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

/**
 * A sped-up utterance aims this far under the time it has, which leaves a beat
 * before the next sentence rather than a bare breath: on a 9 s slot, about
 * 0.4 s, where the voice's own pauses between sentences measure 0.25-0.75 s.
 *
 * (It began as a margin for take-to-take noise, when the fit was a second TTS
 * call. The fit is exact now; the margin stayed because of what it sounds
 * like. The 2% overrun that used to be tolerated for the same reason is gone:
 * it let the NEXT sentence start up to 0.28 s behind its cue on a long slot,
 * to save a speed-up nobody would hear.)
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

/**
 * The prompt file a PROMPTED model's delivery notes are appended to: the 3.1
 * preview, which takes notes and passage as one text (lib/gemini.ts).
 */
const SPEAK_PROMPT = "speak.v1";

/**
 * The fixed part of the style line every model since is given instead. One
 * phrase, on purpose: Google's guidance for the 3.8 models is that long
 * profiles and multi-bullet director's notes are "the most common cause of
 * voice drift", and sent ours, gemini-3.8-flash-tts read them out loud.
 */
const SPEAK_STYLE = "speak.v2";

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
  /**
   * The `Speaker.id` every segment in it shares, which is what its voice is
   * cast from. Undefined when the analysis names no speaker.
   */
  speaker: string | undefined;
}

/**
 * Groups consecutive segments into the units actually spoken. Pure.
 *
 * A new utterance starts when the previous segment ended a sentence, when this
 * segment asks for a pause (the pause sits between calls, where it is exact, and
 * the teacher's beat is a natural place to breathe), when adding it would pass
 * MAX_UTTERANCE_BYTES — or when someone else starts speaking: one call is one
 * voice, so two people are never one utterance.
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
      sourceById.get(segment.id)?.speaker !== sourceById.get(previous.id)?.speaker ||
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
      speaker: sourceById.get(first.id)?.speaker,
    };
  });
}

/** One utterance as the timeline sees it. */
export interface TimelineSlot {
  sourceStartSec: number;
  deadlineSec: number;
  durationSec: number;
  /**
   * How long this utterance should last, on its cue, for the teacher not to be
   * left speaking unheard: the take divided by the tempo it was rehearsed at
   * (rehearseTake). A shorter take is slowed toward it. Left out, it is taken
   * to be STRETCH_BELOW of the slot.
   */
  fillSec?: number;
}

/**
 * The least silence between two utterances that would otherwise touch: one
 * breath. Without it a sentence that ran long is butted against the next.
 */
export const BREATH_SEC = 0.12;

/**
 * Where each utterance goes in the output. Pure.
 *
 * An utterance starts at its source start, or — if the previous one ran long —
 * a breath after the previous one ends. It never starts EARLY: the Hindi for a
 * slide is not spoken over the previous slide.
 *
 * Until 2026-10-06 a `pauseBefore` hint added 350 or 700 ms here on top. The
 * teacher's real pause is already in the source timeline, so the added one only
 * ever did anything when the previous utterance ended on its deadline — where
 * what it did was start the next sentence late. Measured on eight videos: five
 * had a sentence 0.3-0.7 s behind the picture for that reason alone.
 */
export function placeOnTimeline(slots: readonly TimelineSlot[]): {
  startSec: number[];
  endSec: number;
} {
  const startSec: number[] = [];
  let cursor = 0;
  slots.forEach((slot, i) => {
    const start = Math.max(slot.sourceStartSec, i === 0 ? 0 : cursor + BREATH_SEC);
    startSec.push(start);
    cursor = start + slot.durationSec;
  });
  return { startSec, endSec: cursor };
}

/**
 * How much of a slot the teacher is taken to be speaking for when nobody
 * measured it: an utterance filling less is slowed toward this much, and the
 * rest is assumed to be the teacher's own pause. With measured pauses a take
 * is rehearsed against them instead (rehearseTake).
 */
export const STRETCH_BELOW = 0.8;

/** The most an utterance is slowed. Past ~10% a voice starts to sound drugged. */
export const MIN_FIT_TEMPO = 0.9;

/**
 * The tempo for one take with `availableSec` to play in. Pure.
 *
 * Longer than that, it is sped up to land at FIT_AIM of it, capped by
 * MAX_FIT_SPEEDUP. Shorter than `fillSec`, it is slowed toward it, down to
 * MIN_FIT_TEMPO, and never into the beat a sped-up take leaves before the
 * next cue.
 */
function fitTempo(
  durationSec: number,
  availableSec: number,
  fillSec: number,
  last: boolean
): number {
  // The breath and the beat protect the NEXT cue. The last utterance has
  // none: it only has to end with the clip, so it gets all the time there is.
  const aim = last ? 1 : FIT_AIM;

  let tempo = 1;
  if (availableSec <= 0) {
    tempo = MAX_FIT_SPEEDUP;
  } else if (durationSec > availableSec) {
    tempo = Math.min(durationSec / (availableSec * aim), MAX_FIT_SPEEDUP);
  } else {
    const fill = Math.min(fillSec, availableSec * aim);
    if (durationSec < fill) tempo = Math.max(durationSec / fill, MIN_FIT_TEMPO);
  }

  // A speed-up rounds UP, so rounding never leaves it a few ms over its time.
  return tempo > 1
    ? Math.min(Math.ceil(tempo * 1000 - 1e-9) / 1000, MAX_FIT_SPEEDUP)
    : Math.round(tempo * 1000) / 1000;
}

/**
 * The tempo each utterance is re-timed by, or null to leave it alone. Pure.
 *
 * Walks the timeline with the takes' natural durations. An utterance that would
 * not leave a breath before the next one's cue is sped up to land at FIT_AIM of
 * the time it has, capped by MAX_FIT_SPEEDUP. One shorter than it should last
 * (`fillSec`) is slowed toward that, down to MIN_FIT_TEMPO, so the Hindi does
 * not finish early and leave the picture talking to itself. The re-timed
 * duration then carries forward to the next utterance.
 *
 * Tempo is applied with ffmpeg (`conformSpeech`), which is exact — the duration
 * is the natural one divided by the tempo — so the fit itself needs no second
 * TTS call and has no take-to-take noise to plan around.
 */
export function planFit(slots: readonly TimelineSlot[]): (number | null)[] {
  let cursor = 0;
  return slots.map((slot, i) => {
    const start = Math.max(slot.sourceStartSec, i === 0 ? 0 : cursor + BREATH_SEC);
    const last = i === slots.length - 1;
    const available = slot.deadlineSec - start - (last ? 0 : BREATH_SEC);
    // A late start has already let that much of the teacher's speech go by.
    const fill =
      slot.fillSec === undefined
        ? available * STRETCH_BELOW
        : Math.max(0, slot.fillSec - (start - slot.sourceStartSec));

    const tempo = fitTempo(slot.durationSec, available, fill, last);
    cursor = start + slot.durationSec / tempo;
    return tempo === 1 ? null : tempo;
  });
}

/**
 * ============================================================================
 * Phrases — the Hindi placed against the teacher inside a slot (2026-10-07).
 * ============================================================================
 *
 * An utterance starts on its cue and is said in one block, so whatever time it
 * has to spare all lands at the end. Measured on stored takes: the teacher
 * talking over a silent dub for 15.1 s of one minute and 13.5 s of another,
 * and the Hindi for a key term said 5 s before the lecturer got to it. A
 * lecturer who spreads thirteen words over twelve seconds pauses; the voice
 * says them in six and waits.
 *
 * Tempo cannot fix that (the ×0.9 stretch recovered 2.3 s and 1.1 s of it).
 * Position can. The take already has phrases — the voice pauses 0.25-0.75 s
 * where it ends a thought — and the teacher's pauses are measured. So a take
 * with time to spare is cut at its own pauses, and a later phrase is held until
 * the teacher, too, starts again.
 *
 * Nothing is stretched, nothing is cut out and no phrase moves earlier: the
 * only change to the audio is that a pause the voice chose becomes longer.
 */

/**
 * A quiet stretch in a take this long is the voice ending one phrase and
 * starting another. Measured on 45 Gemini takes: 66 of them, 27 of 36 checked
 * falling on a comma, dash or sentence end of the Hindi and the rest where the
 * voice phrased by meaning. Shorter gaps are stop consonants and breath.
 */
export const PHRASE_PAUSE_SEC = 0.25;

/**
 * What counts as quiet, in dBFS over 10 ms. Inside its pauses the voice
 * measured -49 dBFS or lower at the median (breath, not silence); its speech
 * runs -8 to -16.
 */
export const PHRASE_QUIET_DB = -40;

/** How much of a pause stays on each phrase beside it, so no onset or tail is clipped. */
export const PHRASE_EDGE_SEC = 0.05;

/**
 * A phrase shorter than this is not left standing alone before a hold: "तो,"
 * followed by four seconds of nothing is a broken sentence, not a pause. It
 * stays joined to what follows it. The last phrase is exempt — "ठीक है?" after
 * a wait is exactly how a teacher says it.
 */
export const MIN_LEAD_PHRASE_SEC = 0.6;

/**
 * How far past the moment the teacher is proportionally up to a phrase may
 * wait for them to start again. Without it a phrase due now could be held for
 * a pause that ends five seconds on, and the Hindi would fall behind instead.
 */
export const HOLD_PAST_SEC = 1;

/** One phrase of a take, in seconds from the take's start. */
export interface Phrase {
  startSec: number;
  endSec: number;
}

/**
 * Cuts a take into phrases at its own internal pauses. Pure.
 *
 * `quiet` is findQuietRuns() over the take. A run touching either end is the
 * take's edge, not a pause between phrases. Each phrase keeps PHRASE_EDGE_SEC
 * of the pause on either side of it.
 */
export function splitIntoPhrases(
  quiet: readonly { startSec: number; endSec: number }[],
  takeSec: number
): Phrase[] {
  const pauses = quiet.filter(
    (run) =>
      run.endSec - run.startSec >= PHRASE_PAUSE_SEC &&
      run.startSec > PHRASE_EDGE_SEC &&
      run.endSec < takeSec - PHRASE_EDGE_SEC
  );

  const phrases: Phrase[] = [];
  let startSec = 0;
  for (const pause of pauses) {
    const endSec = pause.startSec + PHRASE_EDGE_SEC;
    // Too short to stand alone: the cut is skipped and it joins what follows.
    if (endSec - startSec < MIN_LEAD_PHRASE_SEC) continue;
    phrases.push({ startSec, endSec });
    startSec = pause.endSec - PHRASE_EDGE_SEC;
  }
  phrases.push({ startSec, endSec: takeSec });

  return phrases;
}

/**
 * Where each phrase of one utterance starts on the output timeline. Pure.
 *
 * The first phrase starts on the utterance's cue. Each later one starts where
 * the voice would have put it, unless the Hindi is AHEAD of the teacher there —
 * the teacher has said less of this stretch than the voice has — and the
 * teacher has a measured pause to wait out: then the phrase starts when that
 * pause ends, with the teacher. Of the pauses it could wait for, it takes the
 * one ending nearest the moment the teacher is as far through their speech as
 * the Hindi is through its own.
 *
 * A phrase is never held so long that the rest of the utterance could not
 * still end by `endBySec` as the voice spoke it, so a hold never makes the
 * next utterance late.
 */
export function placePhrases(
  phrases: readonly Phrase[],
  startSec: number,
  endBySec: number,
  teacherPauses: readonly { startSec: number; endSec: number }[]
): number[] {
  const lengths = phrases.map((phrase) => phrase.endSec - phrase.startSec);
  const speech = lengths.reduce((total, length) => total + length, 0);
  // gapBefore[j] is the voice's own pause before phrase j.
  const gapBefore = phrases.map((phrase, j) =>
    j === 0 ? 0 : phrase.startSec - (phrases[j - 1] as Phrase).endSec
  );

  // The teacher's silences inside this utterance's time, in order.
  const silences = teacherPauses
    .map((pause) => ({
      startSec: Math.max(pause.startSec, startSec),
      endSec: Math.min(pause.endSec, endBySec),
    }))
    .filter((pause) => pause.endSec > pause.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const teacherSpeech =
    endBySec -
    startSec -
    silences.reduce((total, pause) => total + (pause.endSec - pause.startSec), 0);

  /** The moment by which the teacher has spoken `amount` seconds of this stretch. */
  const whenTeacherHasSpoken = (amount: number): number => {
    let cursor = startSec;
    let left = amount;
    for (const pause of silences) {
      const run = pause.startSec - cursor;
      if (left <= run) return cursor + left;
      left -= run;
      cursor = pause.endSec;
    }
    return Math.min(cursor + left, endBySec);
  };

  const starts: number[] = [startSec];
  let spoken = 0;
  for (let j = 1; j < phrases.length; j += 1) {
    spoken += lengths[j - 1] ?? 0;
    const natural =
      (starts[j - 1] ?? startSec) + (lengths[j - 1] ?? 0) + (gapBefore[j] ?? 0);

    // From phrase j to the end, as the voice spoke it.
    let rest = 0;
    for (let k = j; k < phrases.length; k += 1) {
      rest += (lengths[k] ?? 0) + (k > j ? (gapBefore[k] ?? 0) : 0);
    }
    const latest = endBySec - rest;

    let start = natural;
    if (speech > 0 && teacherSpeech > 0 && latest > natural) {
      const target = whenTeacherHasSpoken((spoken / speech) * teacherSpeech);
      if (target > natural) {
        const limit = Math.min(latest, target + HOLD_PAST_SEC);
        let nearest = Infinity;
        for (const pause of silences) {
          const onset = pause.endSec;
          if (onset <= natural || onset > limit) continue;
          if (Math.abs(onset - target) < nearest) {
            nearest = Math.abs(onset - target);
            start = onset;
          }
        }
      }
    }
    starts.push(start);
  }

  return starts;
}

/**
 * ============================================================================
 * Pace — a take asked to last as long as the teacher took (2026-10-07).
 * ============================================================================
 *
 * The first five videos voiced by gemini-3.8-flash-tts had a fault a viewer
 * named at once: the teacher's lips moving and nothing to hear. Measured, the
 * Hindi was not short — 85% of its character budget, the rest being the
 * teacher's "um" and "right?" — the VOICE was quick. Asked for "a natural,
 * lively pace" it read at anything from 8.7 to 17 characters a second, and a
 * lecturer who took 14 s over a sentence was dubbed in 9.3. planFit() can give
 * back a tenth of that. On one clip the teacher talked over a silent dub for
 * 17.8 s of 60.
 *
 * The same voice slows down when asked: three of those lines, recorded again
 * with only the pace phrase changed, came back 47%, 56% and 78% longer. So a
 * take that cannot be fitted to the time the teacher took — which is measured
 * — is recorded again, slower or brisker by what it missed by, and whichever
 * take fits best is kept. At most MAX_TAKES of one line are ever recorded.
 *
 * The FIRST take is still asked for the pace the adapter chose, as before.
 * Choosing it from the character count instead was tried, in a dry run over
 * the stored takes, and dropped: on a single line the count is off by a
 * quarter or more, so it asked for "brisk" where the natural take already
 * fitted, and a wrong guess that happens to fit is never corrected. The first
 * take is the measurement; only the second is chosen from it.
 *
 * The re-time stays what it was: the last tenth, exact and free. A pace is the
 * voice deciding how to say it; a tempo is ffmpeg changing what it said.
 */

/** The prompt file the words for each pace are read from: `id: words`, one a line. */
const PACE_WORDS = "pace.v1";

/** The ladder, briskest first. */
export const PACES: readonly TakePace[] = TakePace.options;

/**
 * How long a take comes back at each pace, as a multiple of the same passage
 * at the natural one.
 *
 * MEASURED on gemini-3.8-flash-tts for the words in pace.v1.md: every line
 * that has a natural take and a take at another pace (docs/research.md, Pace),
 * the second over the first.
 *
 *   brisk      mean 0.89 of  4 lines, 0.84 to 1.01
 *   unhurried  mean 1.15 of  7 lines, 0.99 to 1.28
 *   slow       mean 1.51 of 11 lines, 1.20 to 1.89
 *
 * The means are what a pace is chosen by. The ranges are why a take is
 * measured, and recorded again if need be, rather than trusted to land: a pace
 * is a request. New words need new numbers, which is what the version in the
 * file's name is for.
 */
export const PACE_LENGTH: Record<TakePace, number> = {
  brisk: 0.9,
  natural: 1,
  unhurried: 1.15,
  slow: 1.5,
};

/**
 * Reads pace.v1.md: one `id: words` line for each pace. Pure.
 *
 * A pace with no words is an error here, at the first utterance, and not a
 * take directed with the word "undefined".
 */
export function parsePaceWords(file: string): Record<TakePace, string> {
  const found = new Map<string, string>();
  for (const line of file.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    found.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  const wordsFor = (pace: TakePace): string => {
    const words = found.get(pace);
    if (words === undefined || words === "") {
      throw new Error(`No words for the "${pace}" pace in ${PACE_WORDS}.md.`);
    }
    return words;
  };

  return {
    brisk: wordsFor("brisk"),
    natural: wordsFor("natural"),
    unhurried: wordsFor("unhurried"),
    slow: wordsFor("slow"),
  };
}

/** The time one utterance has, measured from its own cue. */
export interface UtteranceTiming {
  cueSec: number;
  /** Nothing follows the last utterance, so it owes no breath or beat to a next cue. */
  last: boolean;
  /** From the cue to a breath before the next one: the most a take may occupy. */
  roomSec: number;
  /**
   * How long the teacher is speaking in that room: the room less every
   * measured pause in it. Undefined when no pauses were measured.
   */
  speechSec: number | undefined;
}

/**
 * How long the teacher is speaking between two moments: the span less every
 * measured pause in it. Pure.
 */
export function speechWithin(
  startSec: number,
  endSec: number,
  pauses: readonly { startSec: number; endSec: number }[]
): number {
  let quiet = 0;
  for (const pause of pauses) {
    quiet += Math.max(
      0,
      Math.min(pause.endSec, endSec) - Math.max(pause.startSec, startSec)
    );
  }
  return Math.max(0, endSec - startSec - quiet);
}

/**
 * The room one utterance has on its cue, and how much of it the teacher
 * speaks for. Pure.
 *
 * `pauses` is every pause stage 1 measured; an empty list means nobody
 * measured, not that the teacher never paused.
 */
export function timeFor(
  cueSec: number,
  deadlineSec: number,
  last: boolean,
  pauses: readonly { startSec: number; endSec: number }[]
): UtteranceTiming {
  const roomSec = Math.max(0, deadlineSec - cueSec - (last ? 0 : BREATH_SEC));
  return {
    cueSec,
    last,
    roomSec,
    speechSec:
      pauses.length === 0 ? undefined : speechWithin(cueSec, cueSec + roomSec, pauses),
  };
}

/**
 * A mouth moving over silence for this long is a pause: everyone's speech has
 * them, and the voice's own, at the natural pace, measured 0.25 to 0.40 s.
 * Only what a stretch runs past this counts as the teacher speaking unheard.
 */
export const LIP_GRACE_SEC = 0.4;

/**
 * Seconds a viewer watches the teacher speak with no Hindi to hear. Pure.
 *
 * Every stretch between `fromSec` and `toSec` in which the Hindi is not
 * playing and the teacher is not in a measured pause, less LIP_GRACE_SEC each.
 * `playing` is where the Hindi is.
 */
export function silentLipsSec(
  playing: readonly { startSec: number; endSec: number }[],
  fromSec: number,
  toSec: number,
  pauses: readonly { startSec: number; endSec: number }[]
): number {
  // Either way there is nothing to see: the Hindi is on, or the lips are still.
  const covered = [...playing, ...pauses]
    .map((span) => ({
      startSec: Math.max(span.startSec, fromSec),
      endSec: Math.min(span.endSec, toSec),
    }))
    .filter((span) => span.endSec > span.startSec)
    .sort((a, b) => a.startSec - b.startSec);

  let silent = 0;
  let cursor = fromSec;
  for (const span of covered) {
    silent += Math.max(0, span.startSec - cursor - LIP_GRACE_SEC);
    cursor = Math.max(cursor, span.endSec);
  }
  return silent + Math.max(0, toSec - cursor - LIP_GRACE_SEC);
}

/** What becomes of one take if it is the one that is used. */
export interface Rehearsal {
  /**
   * The re-time it gets on its cue: sped up to make the next one, or slowed as
   * far as it takes to leave the teacher speaking unheard for least.
   */
  tempo: number;
  /**
   * Seconds past its room even at the fastest tempo. The next line starts this
   * far behind its cue.
   */
  lateSec: number;
  /**
   * Seconds the teacher is seen speaking with no Hindi to hear, once the take
   * is re-timed and placed (silentLipsSec). Zero when no pauses were measured:
   * there is nothing to judge it against.
   */
  silentSec: number;
  /**
   * The part of that which a LONGER take would put right: the teacher still
   * talking after the Hindi has ended, or while it waits at a hold for the
   * teacher to catch up. The rest is the voice pausing where the teacher did
   * not, which another take would only move.
   */
  shortSec: number;
}

/** How fine the tempos a take is rehearsed at are. */
const TEMPO_STEP = 0.01;

/**
 * A slower tempo has to leave the teacher unheard for at least this much less
 * to be taken over one nearer the take as spoken.
 */
const WORTH_SLOWING_SEC = 0.05;

/**
 * Rehearses one take on its own cue: re-times it, places its phrases against
 * the teacher's pauses the way the stage will, and measures what a viewer
 * would be left watching. Pure.
 *
 * `quiet` is findQuietRuns() over the take as spoken.
 *
 * A take that fits its room is tried at every tempo from as-spoken down to the
 * slowest allowed, and gets the one nearest as-spoken that leaves the teacher
 * speaking unheard for least. That is slower than "as long as the teacher
 * speaks" whenever the teacher pauses where this take has no pause of its own
 * to wait at — it has to talk through that pause, and still be talking when
 * the teacher is — and no slower than it needs to be.
 */
export function rehearseTake(
  durationSec: number,
  quiet: readonly { startSec: number; endSec: number }[],
  timing: UtteranceTiming,
  pauses: readonly { startSec: number; endSec: number }[]
): Rehearsal {
  const { cueSec, last, roomSec } = timing;
  const lateSec = Math.max(0, durationSec / MAX_FIT_SPEEDUP - roomSec);

  // Nobody measured the teacher's pauses: the old estimate, and no verdict.
  if (timing.speechSec === undefined) {
    return {
      tempo: fitTempo(durationSec, roomSec, roomSec * STRETCH_BELOW, last),
      lateSec,
      silentSec: 0,
      shortSec: 0,
    };
  }

  // Where a take stops being stretched: the beat before the next cue.
  const beatSec = roomSec * (last ? 1 : FIT_AIM);
  const at = (tempo: number): Rehearsal => {
    const phrases = splitIntoPhrases(
      quiet.map((run) => ({
        startSec: run.startSec / tempo,
        endSec: run.endSec / tempo,
      })),
      durationSec / tempo
    );
    const starts = placePhrases(phrases, cueSec, cueSec + roomSec, pauses);
    const playing = phrases.map((phrase, j) => {
      const startSec = starts[j] ?? cueSec;
      return { startSec, endSec: startSec + (phrase.endSec - phrase.startSec) };
    });

    // The same phrases, run together wherever the voice's own pause was all
    // that separated them: what is left between runs is a hold.
    const runs: { startSec: number; endSec: number }[] = [];
    playing.forEach((span, j) => {
      const run = runs.at(-1);
      const before = phrases[j - 1];
      const ownPause =
        before === undefined ? 0 : (phrases[j]?.startSec ?? 0) - before.endSec;
      if (run !== undefined && span.startSec - run.endSec - ownPause < 0.001) {
        run.endSec = span.endSec;
      } else {
        runs.push({ ...span });
      }
    });

    const within = [cueSec, cueSec + beatSec, pauses] as const;
    return {
      tempo,
      lateSec,
      silentSec: silentLipsSec(playing, ...within),
      shortSec: silentLipsSec(runs, ...within),
    };
  };

  // Too long for its room: sped up, and there is nothing to choose.
  const fastest = fitTempo(durationSec, roomSec, 0, last);
  if (fastest > 1) return at(fastest);

  const slowest = Math.max(MIN_FIT_TEMPO, durationSec / beatSec);
  const tried = [at(1)];
  for (let step = 1; ; step += 1) {
    const tempo = Math.round((1 - step * TEMPO_STEP) * 1000) / 1000;
    if (tempo < slowest - 1e-9) break;
    tried.push(at(tempo));
  }

  const least = Math.min(...tried.map((entry) => entry.silentSec));
  // In order of tempo, so the first good enough is the nearest to as-spoken.
  return (
    tried.find((entry) => entry.silentSec <= least + WORTH_SLOWING_SEC) ??
    (tried[0] as Rehearsal)
  );
}

/**
 * Of `among`, the pace whose takes come closest to `factor` times the natural
 * length; undefined when there is none to choose from.
 *
 * Closest as a ratio: a take 20% too long and one 20% too short are equally
 * far off.
 */
function nearestPace(factor: number, among: readonly TakePace[]): TakePace | undefined {
  let best: TakePace | undefined;
  let nearest = Infinity;
  for (const pace of among) {
    const distance = Math.abs(Math.log(factor / PACE_LENGTH[pace]));
    if (distance < nearest) {
      nearest = distance;
      best = pace;
    }
  }
  return best;
}

/**
 * The pace the adapter's `speakingRate` asks for: what a first take is
 * recorded at. Pure.
 *
 * The same three bands, in the same words, that were sent before a take could
 * be recorded twice.
 */
export function paceOfRate(rate: number): TakePace {
  if (rate <= 0.9) return "unhurried";
  if (rate >= 1.08) return "brisk";
  return "natural";
}

/**
 * The most takes of one utterance: the first, and two more.
 *
 * Two, because a pace is a request and not a setting. Of the first twelve
 * second takes recorded, one came back no longer than the take it was meant to
 * improve on (a 23 s line, asked for "unhurried": 17.8 s after 18.0 s). A third
 * take, a step further along the ladder, is what that line still had coming.
 */
export const MAX_TAKES = 3;

/**
 * A take that would start the next line this far behind its cue is recorded
 * again. A fifth of a second is about where a late voice starts to show
 * against the lips; under it, a second call buys nothing anyone would see.
 */
export const RETAKE_LATE_SEC = 0.2;

/**
 * So is a take this much too short for the teacher, over and above the grace:
 * 0.7 s of the teacher talking on after the line has ended, say. Less reads as
 * the teacher finishing a word; more is the silent mouth this section exists
 * to remove.
 */
export const RETAKE_SILENT_SEC = 0.3;

/**
 * One number for how badly a take fits, to choose between two. Pure.
 *
 * Lateness counts double. A take that ends early spoils its own slot; one that
 * ends late moves the next line's cue as well.
 */
export function misfitSec(rehearsal: Pick<Rehearsal, "lateSec" | "silentSec">): number {
  return 2 * rehearsal.lateSec + rehearsal.silentSec;
}

/**
 * The pace to record a second take at, or undefined when the first will do —
 * or when there is nothing slower or brisker left to ask for. Pure.
 *
 * The first take is the measurement: divided by its own pace's length, it says
 * how long THIS passage takes this voice at the natural pace, which a
 * character count can only estimate. The second take is asked for the pace
 * that would bring that to the length wanted — all the room there is if the
 * first was long; if it was short, as long as it was placed plus the time it
 * fell short of the teacher by — looking only at paces on that side of the
 * first: slower ones for a short take, brisker ones for a long.
 *
 * Only a take that is too SHORT is recorded again slower. One that lasts as
 * long as the teacher and still leaves a gap in the middle is pausing where
 * the teacher did not, and there is no room left to make it longer.
 */
export function retakePace(
  first: TakePace,
  durationSec: number,
  rehearsal: Rehearsal,
  timing: Pick<UtteranceTiming, "roomSec" | "last">
): TakePace | undefined {
  const late = rehearsal.lateSec > RETAKE_LATE_SEC;
  if (!late && rehearsal.shortSec <= RETAKE_SILENT_SEC) return undefined;

  const beatSec = timing.roomSec * (timing.last ? 1 : FIT_AIM);
  const wantedSec = late
    ? beatSec
    : Math.min(durationSec / rehearsal.tempo + rehearsal.shortSec, beatSec);
  const naturalSec = durationSec / PACE_LENGTH[first];
  const tried = PACES.indexOf(first);
  return nearestPace(
    wantedSec / naturalSec,
    late ? PACES.slice(0, tried) : PACES.slice(tried + 1)
  );
}

/**
 * Which of an utterance's takes to keep, by index: the one that fits its time
 * best, and the earlier one when they fit equally. Pure.
 */
export function chooseTake(
  rehearsals: readonly Pick<Rehearsal, "lateSec" | "silentSec">[]
): number {
  let kept = 0;
  let least = Infinity;
  rehearsals.forEach((rehearsal, index) => {
    const misfit = misfitSec(rehearsal);
    if (misfit < least) {
      least = misfit;
      kept = index;
    }
  });
  return kept;
}

/**
 * The house delivery, used when a caller does not give one.
 *
 * Deliberately the only thing about the voice that is the same for every clip,
 * and deliberately an argument rather than a line in the prompt: who the
 * teacher is comes from each clip's own brief and the mood from each segment,
 * and this — like the voice itself — is what a user-facing "how should it
 * sound" setting would replace.
 */
export const DEFAULT_SPEAKING_STYLE =
  "Be good company: engaged, warm, a little animated, the kind of teacher a " +
  "student enjoys listening to.";

/**
 * How the adapter's `speakingRate` is said to a voice that takes direction.
 * Used only when a caller gives no pace of its own (see Pace, above).
 */
function paceWords(rate: number): string {
  if (rate <= 0.9) return "slow and deliberate, giving it room to land";
  if (rate >= 1.08) return "quick and light";
  return "a natural, lively teaching pace";
}

/** The same, for a style line. */
function paceStyle(rate: number): string {
  if (rate <= 0.9) return "slow and deliberate";
  if (rate >= 1.08) return "quick and light";
  return "a natural, lively pace";
}

/**
 * The delivery for one utterance as ONE short style line: who is speaking, the
 * mood stage 1 heard, the pace, the house phrase, and the Hindi words that
 * carry the stress. Pure.
 *
 * This is the same reading of the teacher that buildSpeechDirection() writes
 * out as notes, cut down to what a model that takes a style can use: it is
 * given the passage as its text and this as how to say it, and nothing else.
 * The mood is the first segment's; an utterance is one sentence, and a
 * sentence has one. `house` is speak.v2.md unless a caller asks otherwise.
 * `pace` is the words for the pace this take is asked for (pace.v1.md); left
 * out, it is read off the adapter's rate, as it was before 2026-10-07.
 *
 * The wording is exactly what was sent on 2026-10-07, when four lines in two
 * voices came back at the length their text predicts.
 */
export function buildSpeechStyle(
  utterance: PlannedUtterance,
  sourceById: ReadonlyMap<string, AnalyzedSegment>,
  persona: string,
  house: string,
  someoneElse?: Pick<Speaker, "description">,
  pace?: string
): string {
  const first = utterance.segments[0];
  const source = first === undefined ? undefined : sourceById.get(first.id);
  // The persona's opening clause says who this is; the rest is how they teach.
  const who = someoneElse?.description ?? (persona.split(/[.;]/)[0] ?? persona).trim();
  const stress = utterance.segments.flatMap((segment) =>
    segment.emphasisTerms.filter(
      (term) => term.trim() !== "" && segment.targetText.includes(term)
    )
  );

  return (
    `${who}.` +
    (source === undefined ? "" : ` Mood ${source.register};`) +
    ` ${pace ?? paceStyle(utterance.requestedRate)}; ${house}.` +
    (stress.length === 0 ? "" : ` Lean on: ${stress.join(", ")}.`)
  );
}

/**
 * The delivery notes and the passage for one utterance, appended to speak.v1.md.
 * Pure.
 *
 * This is where stage 1's reading of the teacher finally reaches the audio: the
 * instructional move, the register, the pace, and the Hindi words that carry
 * the stress the speaker put on the English. Chirp 3 HD took none of it.
 *
 * `targetSec` is the time the passage has in the video. It is direction, not a
 * guarantee — planFit() makes up the difference.
 */
export function buildSpeechDirection(
  utterance: PlannedUtterance,
  sourceById: ReadonlyMap<string, AnalyzedSegment>,
  persona: string,
  targetSec: number,
  style: string = DEFAULT_SPEAKING_STYLE,
  /**
   * Set when this utterance is NOT the teacher's: a question from the room, a
   * colleague's reply. They are described as stage 1 described them, and the
   * teacher's persona and house style — which are about the teacher — are left
   * out rather than put in someone else's mouth.
   */
  someoneElse?: Pick<Speaker, "description">,
  /** The words for the pace asked for; left out, read off the adapter's rate. */
  pace?: string
): string {
  const lines: string[] = [
    "## Delivery notes (never spoken)",
    "",
    ...(someoneElse === undefined
      ? [
          `The teacher: ${persona}`,
          `${style} Within that, follow the mood noted for each part.`,
        ]
      : [
          `This is not the teacher speaking. It is ${someoneElse.description}.`,
          "Say it the way that person would, in the mood noted for each part.",
        ]),
    `Pace: ${pace ?? paceWords(utterance.requestedRate)}. The whole passage should take ` +
      `about ${Math.max(1, Math.round(targetSec))} seconds.`,
    "",
  ];

  for (const segment of utterance.segments) {
    const source = sourceById.get(segment.id);
    const stress = segment.emphasisTerms.filter(
      (term) => term.trim() !== "" && segment.targetText.includes(term)
    );
    lines.push(
      `- "${segment.targetText.trim()}"` +
        (source === undefined
          ? ""
          : ` — this is a ${source.signal.replace("_", " ")}; mood ${source.register}`) +
        (stress.length === 0 ? "" : `; lean on: ${stress.join(", ")}`)
    );
  }

  lines.push("", "## The passage (speak exactly this)", "", utterance.text);
  return lines.join("\n");
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
  /**
   * Where the teacher paused, as stage 1 measured it (`AcousticEvidence.pauses`).
   * With it, a take that has time to spare is placed phrase by phrase against
   * those pauses; without it every take is one block on its cue.
   */
  pauses?: readonly MeasuredPause[];
  /** The Cloud TTS voice, used when the engine is `chirp`. */
  voice?: string;
  engine?: "gemini" | "chirp";
  /**
   * ONE Gemini TTS voice name ("Charon", "Kore", …) for every speaker: an
   * override, for comparing voices. Left out, each speaker is cast from config
   * by how stage 1 says their own voice sounds (speakers.ts).
   */
  geminiVoice?: string;
  /** The overall delivery asked of the voice. Defaults to DEFAULT_SPEAKING_STYLE. */
  style?: string;
  onProgress?: (done: number, total: number) => void;
}

export interface SynthesizeOutput {
  synthesis: Synthesis;
  /** Per-utterance WAV paths (the kept take), in order. */
  utteranceFiles: string[];
  /**
   * The finished Hindi as lossless WAV, at the playback level: what
   * `synthesis.audioUri` was encoded from, and what belongs under the video.
   * Optional so a stubbed stage need not make one.
   */
  masterFile?: string;
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
  /** The engine's audio as returned, kept so a re-time starts from the original. */
  rawFile: string;
  /** Trimmed and in SPEECH_FORMAT; what is placed if no re-time is needed. */
  file: string;
  durationSec: number;
  engine: "gemini" | "chirp";
  voice: string;
  /** The pace it was asked for. `natural` for Chirp, which takes a rate instead. */
  pace: TakePace;
  /** What using this take would look like (rehearseTake). */
  rehearsal: Rehearsal;
  /** The `speaking_rate` Chirp was asked for; 1 for Gemini, which is paced in words. */
  engineRate: number;
  billedChars: number;
  latencyMs: number;
}

/** One WAV as it is laid on the output timeline: a whole take, or one phrase of it. */
interface Piece {
  file: string;
  startSec: number;
  durationSec: number;
  /** Silence added before it beyond the voice's own pause: the wait for the teacher. */
  heldSec: number;
}

/**
 * A Gemini take this far from the length its text predicts AT THE PACE IT WAS
 * ASKED FOR is not a reading of the passage — it read the notes aloud, or
 * stopped early — and is thrown away.
 */
const TAKE_LENGTH_BOUNDS = { min: 0.45, max: 2.2 };

/**
 * Synthesizes, fits and places every utterance, then joins and measures.
 *
 * One TTS call per utterance, and another for a take that cannot be fitted to
 * its time (see Pace, above). With the `gemini` engine the call carries the
 * delivery from buildSpeechStyle() or buildSpeechDirection(); an utterance
 * Gemini TTS fails or reads wrongly is spoken by the Chirp 3 HD voice of the
 * same name instead, so one bad call does not cost the job. The kept take is
 * then trimmed, re-timed where planFit() says so, and placed.
 */
export async function runSynthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
  const { analysis, adaptation, outDir, onProgress } = input;
  const engine = input.engine ?? config.tts.engine;
  const geminiVoice = input.geminiVoice ?? config.tts.geminiVoice;

  /**
   * The cast: a voice for each speaker stage 1 heard, matched to how their own
   * voice sounds and different from every other speaker's. An explicit voice
   * from the caller overrides it for everyone; a job with no speakers in its
   * analysis has an empty cast and is spoken in the default voice, as before.
   */
  const cast =
    input.geminiVoice !== undefined
      ? new Map<string, string>()
      : castVoices(analysis.speakers ?? [], {
          female: config.tts.femaleVoices,
          male: config.tts.maleVoices,
          fallback: config.tts.geminiVoice,
        });
  const castFor = (utterance: PlannedUtterance) =>
    utterance.speaker === undefined ? undefined : cast.get(utterance.speaker);
  const geminiVoiceFor = (utterance: PlannedUtterance) =>
    castFor(utterance) ?? geminiVoice;
  // The same speaker in the other engine: Chirp 3 HD and Gemini TTS share voices.
  const chirpVoiceFor = (utterance: PlannedUtterance) => {
    if (engine === "gemini") {
      return `${TTS_LANGUAGE_CODE}-Chirp3-HD-${geminiVoiceFor(utterance)}`;
    }
    const name = castFor(utterance);
    return (
      input.voice ??
      (name === undefined ? TTS_VOICE : `${TTS_LANGUAGE_CODE}-Chirp3-HD-${name}`)
    );
  };
  // Whoever talks for longest is "the teacher" the brief's persona describes.
  const teacher = mainSpeaker(analysis);

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
  const deadlineOf = (i: number) => planned[i + 1]?.sourceStartSec ?? sourceDurationSec;

  const speakPrompt = engine === "gemini" ? loadPrompt(SPEAK_PROMPT) : "";
  const speakStyle = engine === "gemini" ? loadPrompt(SPEAK_STYLE).trim() : "";
  const paceWordsFor =
    engine === "gemini" ? parsePaceWords(loadPrompt(PACE_WORDS)) : undefined;

  // What each utterance has to fit, from its own cue: what its first take is
  // judged against, and its second take's pace chosen from.
  const teacherPauses = input.pauses ?? [];
  const timings = planned.map((utterance, i) =>
    timeFor(
      utterance.sourceStartSec,
      deadlineOf(i),
      i === planned.length - 1,
      teacherPauses
    )
  );
  const timingOf = (utterance: PlannedUtterance) =>
    timings[utterance.index] as UtteranceTiming;

  // Named by position, not by id: ids came from the model, and a file name
  // built from one is a duplicate away from overwriting another.
  const fileFor = (utterance: PlannedUtterance, label: string) =>
    path.join(utteranceDir, `${String(utterance.index).padStart(3, "0")}-${label}.wav`);

  const speakWithChirp = async (utterance: PlannedUtterance) => {
    const chirpVoice = chirpVoiceFor(utterance);
    const result = await synthesize({
      input: { mode: "text", content: utterance.text },
      voice: chirpVoice,
      speakingRate: utterance.requestedRate,
    });
    return {
      audio: result.audio,
      engine: "chirp" as const,
      voice: chirpVoice,
      pace: "natural" as const,
      engineRate: result.speakingRate,
      latencyMs: result.latencyMs,
    };
  };

  const speakWithGemini = async (utterance: PlannedUtterance, pace: TakePace) => {
    // How long the text takes at the pace asked for, by the character count.
    const expectedSec =
      (countSpokenChars(utterance.text) / MEASURED_CHARS_PER_SEC) * PACE_LENGTH[pace];
    // The seconds a PROMPTED model is told to take: as long as the teacher
    // speaks, but never a pace the text cannot be said at.
    const timing = timingOf(utterance);
    const targetSec = Math.min(
      Math.max(timing.speechSec ?? timing.roomSec * STRETCH_BELOW, expectedSec * 0.85),
      expectedSec * 1.15
    );
    const paceWords = paceWordsFor?.[pace];

    const voice = geminiVoiceFor(utterance);
    const speaker = analysis.speakers?.find((entry) => entry.id === utterance.speaker);
    const other =
      speaker !== undefined && speaker.id !== teacher?.id ? speaker : undefined;

    const result = await generateSpeech({
      // Both forms of the same direction; lib/gemini.ts sends the one the
      // model takes — the passage with a style, or notes and passage as one.
      text: utterance.text,
      style: buildSpeechStyle(
        utterance,
        sourceById,
        adaptation.brief.instructorPersona,
        input.style ?? speakStyle,
        other,
        paceWords
      ),
      prompt:
        speakPrompt +
        "\n\n" +
        buildSpeechDirection(
          utterance,
          sourceById,
          adaptation.brief.instructorPersona,
          targetSec,
          input.style,
          other,
          paceWords
        ),
      voice,
      languageCode: TTS_LANGUAGE_CODE,
    });

    const probe = fileFor(utterance, "probe");
    fs.writeFileSync(probe, result.audio);
    const ratio = (await probeDurationSec(probe)) / expectedSec;
    fs.rmSync(probe, { force: true });
    if (ratio < TAKE_LENGTH_BOUNDS.min || ratio > TAKE_LENGTH_BOUNDS.max) {
      throw new Error(
        `Gemini TTS take is ${ratio.toFixed(2)}x the length its text predicts.`
      );
    }

    return {
      audio: result.audio,
      engine: "gemini" as const,
      voice: `${GEMINI_TTS_MODEL}/${voice}`,
      pace,
      engineRate: 1,
      latencyMs: result.latencyMs,
    };
  };

  type Spoken = Awaited<ReturnType<typeof speakWithGemini | typeof speakWithChirp>>;

  /** Writes what an engine returned and trims it. `nth` is 0 for the first take. */
  const keep = async (
    utterance: PlannedUtterance,
    spoken: Spoken,
    nth: number
  ): Promise<Take> => {
    const rawFile = fileFor(utterance, nth === 0 ? "raw" : `retake${nth}-raw`);
    const file = fileFor(utterance, nth === 0 ? "a" : `retake${nth}`);
    fs.writeFileSync(rawFile, spoken.audio);
    await conformSpeech(rawFile, file);

    const durationSec = await probeDurationSec(file);
    const { format, samples } = readMono16(fs.readFileSync(file));
    const quiet = findQuietRuns(samples, format.sampleRate, {
      thresholdDb: PHRASE_QUIET_DB,
      minSec: PHRASE_PAUSE_SEC,
    });

    return {
      rawFile,
      file,
      durationSec,
      rehearsal: rehearseTake(durationSec, quiet, timingOf(utterance), teacherPauses),
      engine: spoken.engine,
      voice: spoken.voice,
      pace: spoken.pace,
      engineRate: spoken.engineRate,
      billedChars: utterance.text.length,
      latencyMs: spoken.latencyMs,
    };
  };

  /**
   * Every take recorded for one utterance: one, and another for as long as the
   * last one could not be fitted to its time, there is a pace it has not been
   * asked for at, and MAX_TAKES allows.
   */
  let done = 0;
  const record = async (utterance: PlannedUtterance): Promise<Take[]> => {
    const timing = timingOf(utterance);
    const takes: Take[] = [];

    if (engine === "gemini") {
      const pace = paceOfRate(utterance.requestedRate);
      takes.push(
        await keep(
          utterance,
          await speakWithGemini(utterance, pace).catch(() => speakWithChirp(utterance)),
          0
        )
      );

      while (takes.length < MAX_TAKES) {
        const last = takes.at(-1) as Take;
        // A take Chirp had to speak is not re-taken: it takes a rate, not a pace.
        if (last.engine !== "gemini") break;
        const again = retakePace(last.pace, last.durationSec, last.rehearsal, timing);
        if (again === undefined || takes.some((entry) => entry.pace === again)) break;

        // If it fails, the takes there are stand: another take is an
        // improvement, and never the reason a line goes to Chirp.
        const next = await speakWithGemini(utterance, again).catch(() => undefined);
        if (next === undefined) break;
        takes.push(await keep(utterance, next, takes.length));
      }
    } else {
      takes.push(await keep(utterance, await speakWithChirp(utterance), 0));
    }

    onProgress?.(++done, planned.length);
    return takes;
  };

  const recorded = await mapBounded(planned, SYNTH_CONCURRENCY, record);
  const keptIndex = recorded.map((takes) =>
    chooseTake(takes.map((entry) => entry.rehearsal))
  );
  /** The take each utterance is heard in, as the voice spoke it. */
  const chosen = recorded.map((takes, i) => takes[keptIndex[i] ?? 0] as Take);

  // How long each should last is what its rehearsal settled on: the take as
  // spoken, over the tempo that left the teacher unheard for least.
  const slots = (durations: readonly number[]): TimelineSlot[] =>
    planned.map((utterance, i) => {
      const take = chosen[i] as Take;
      return {
        sourceStartSec: utterance.sourceStartSec,
        deadlineSec: deadlineOf(i),
        durationSec: durations[i] ?? 0,
        ...(timings[i]?.speechSec === undefined
          ? {}
          : { fillSec: take.durationSec / take.rehearsal.tempo }),
      };
    });

  const tempos = planFit(slots(chosen.map((entry) => entry.durationSec)));

  const kept = await Promise.all(
    chosen.map(async (entry, i) => {
      const tempo = tempos[i] ?? null;
      if (tempo === null) return entry;
      const file = fileFor(planned[i] as PlannedUtterance, "b");
      await conformSpeech(entry.rawFile, file, { tempo });
      return { ...entry, file, durationSec: await probeDurationSec(file) };
    })
  );

  const finalSlots = slots(kept.map((entry) => entry.durationSec));
  const placed = placeOnTimeline(finalSlots);

  /**
   * What is written for each utterance: the take whole, or — where it has time
   * to spare, pauses of its own and a teacher who paused too — its phrases,
   * with a later one held until the teacher starts again (placePhrases).
   */
  const pieces: Piece[][] = kept.map((entry, i) => {
    const start = placed.startSec[i] ?? 0;
    const whole = [
      { file: entry.file, startSec: start, durationSec: entry.durationSec, heldSec: 0 },
    ];
    if (teacherPauses.length === 0) return whole;

    const next = placed.startSec[i + 1];
    const endBy = next === undefined ? sourceDurationSec : next - BREATH_SEC;
    if (start + entry.durationSec >= endBy) return whole;

    const { format, samples } = readMono16(fs.readFileSync(entry.file));
    const rate = format.sampleRate;
    const phrases = splitIntoPhrases(
      findQuietRuns(samples, rate, {
        thresholdDb: PHRASE_QUIET_DB,
        minSec: PHRASE_PAUSE_SEC,
      }),
      samples.length / rate
    );
    if (phrases.length < 2) return whole;

    const starts = placePhrases(phrases, start, endBy, teacherPauses);
    const held = phrases.map((phrase, j) => {
      const before = phrases[j - 1];
      return before === undefined
        ? 0
        : (starts[j] ?? 0) -
            ((starts[j - 1] ?? 0) + (before.endSec - before.startSec)) -
            (phrase.startSec - before.endSec);
    });
    // Nothing held: the take is placed as it was spoken, byte for byte.
    if (held.every((sec) => sec < 0.001)) return whole;

    // Cut only where a phrase is held. Phrases that run on as the voice spoke
    // them stay one piece, with the pause — and the breath in it — between them.
    const runs: { fromSec: number; toSec: number; startSec: number; heldSec: number }[] =
      [];
    phrases.forEach((phrase, j) => {
      const current = runs.at(-1);
      if (current !== undefined && (held[j] ?? 0) < 0.001) {
        current.toSec = phrase.endSec;
        return;
      }
      runs.push({
        fromSec: phrase.startSec,
        toSec: phrase.endSec,
        startSec: starts[j] ?? start,
        heldSec: Math.max(0, held[j] ?? 0),
      });
    });

    return runs.map((run, j) => {
      const from = Math.round(run.fromSec * rate);
      const to = Math.round(run.toSec * rate);
      const file = fileFor(planned[i] as PlannedUtterance, `p${j}`);
      fs.writeFileSync(file, sliceMono16(samples, format, from, to));
      return {
        file,
        startSec: run.startSec,
        durationSec: (to - from) / rate,
        heldSec: run.heldSec,
      };
    });
  });

  /**
   * The join: silence up to each piece's start, the piece, and silence to the
   * source's end. Every take was conformed to SPEECH_FORMAT, and the silence
   * is written in it, so the concat demuxer's `-c copy` stays a byte-level
   * join whichever engine spoke.
   */
  const parts: string[] = [];
  const gapBeforeMs: number[] = [];
  let cursor = 0;
  const gap = (sec: number, name: string) => {
    if (sec < 0.001) return;
    const file = path.join(utteranceDir, `${name}.silence.wav`);
    fs.writeFileSync(file, silenceWav(sec, SPEECH_FORMAT));
    parts.push(file);
  };
  pieces.forEach((utterancePieces, i) => {
    const name = String(i).padStart(3, "0");
    utterancePieces.forEach((piece, j) => {
      if (j === 0) {
        gapBeforeMs.push(Math.max(0, Math.round((piece.startSec - cursor) * 1000)));
      }
      gap(piece.startSec - cursor, j === 0 ? name : `${name}-p${j}`);
      parts.push(piece.file);
      cursor = piece.startSec + piece.durationSec;
    });
  });
  gap(sourceDurationSec - cursor, "tail");

  // Leveled once, on the lossless join; the mp3 is then encoded at the voice's
  // own rate, not the 16 kHz of the analysis copy, which cut its top octave.
  const joinedWav = path.join(outDir, "joined.wav");
  const masterWav = path.join(outDir, "output.wav");
  const outputMp3 = path.join(outDir, "output.mp3");
  await concatAudio(parts, joinedWav);
  await normalizeSpeechLoudness(joinedWav, masterWav);
  await encodeMp3(masterWav, outputMp3, { sampleRate: SPEECH_FORMAT.sampleRate });
  const durationSec = await probeDurationSec(outputMp3);

  const utterances: SynthesizedUtterance[] = planned.map((utterance, i) => {
    const takes = recorded[i] as Take[];
    const chosenTake = chosen[i] as Take;
    const keptTake = kept[i] as Take;
    const tempo = tempos[i] ?? null;
    const speechSec = timings[i]?.speechSec;
    return {
      index: utterance.index,
      segmentIds: utterance.segments.map((segment) => segment.id),
      sourceStartSec: utterance.sourceStartSec,
      deadlineSec: finalSlots[i]?.deadlineSec ?? sourceDurationSec,
      markupUsed: utterance.text,
      inputMode: "text",
      engine: chosenTake.engine,
      requestedRate: utterance.requestedRate,
      // The engine's own rate times the re-time: what a listener hears relative
      // to the take as the voice spoke it, at whatever pace it was asked for.
      speakingRate: Math.round(chosenTake.engineRate * (tempo ?? 1) * 1000) / 1000,
      naturalDurationSec: chosenTake.durationSec,
      measuredDurationSec: keptTake.durationSec,
      refit: tempo !== null,
      ...(speechSec === undefined
        ? {}
        : { speechSec: Math.round(speechSec * 1000) / 1000 }),
      // Chirp was not asked for a pace, so an utterance it spoke reports none.
      ...(chosenTake.engine === "gemini" ? { pace: chosenTake.pace } : {}),
      ...(takes.length < 2
        ? {}
        : {
            takes: takes.map((entry, j) => ({
              pace: entry.pace,
              durationSec: entry.durationSec,
              lateSec: Math.round(entry.rehearsal.lateSec * 1000) / 1000,
              silentSec: Math.round(entry.rehearsal.silentSec * 1000) / 1000,
              kept: j === (keptIndex[i] ?? 0),
            })),
          }),
      // The silence actually written before it — the teacher's pause as it
      // survives on the timeline, not the adapter's hint.
      pauseBeforeMs: gapBeforeMs[i] ?? 0,
      outputStartSec: placed.startSec[i] ?? 0,
      ...((pieces[i]?.length ?? 0) < 2
        ? {}
        : {
            phrases: (pieces[i] ?? []).map((piece) => ({
              startSec: Math.round(piece.startSec * 1000) / 1000,
              durationSec: Math.round(piece.durationSec * 1000) / 1000,
              heldSec: Math.round(piece.heldSec * 1000) / 1000,
            })),
          }),
      // Every take was billed and waited for, kept or not.
      billedChars: takes.reduce((total, entry) => total + entry.billedChars, 0),
      latencyMs: takes.reduce((total, entry) => total + entry.latencyMs, 0),
    };
  });

  const segments: SynthesizedSegment[] = planned.flatMap((utterance, i) =>
    utterance.segments.map((adapted) => {
      const source = sourceById.get(adapted.id) as AnalyzedSegment;
      const present = adapted.emphasisTerms.filter(
        (term) => term.trim() !== "" && adapted.targetText.includes(term)
      );
      const spokenBy = (chosen[i] as Take).engine;
      return {
        id: adapted.id,
        startSec: source.startSec,
        endSec: source.endSec,
        voice: (chosen[i] as Take).voice,
        speakingRate: (utterances[i] as SynthesizedUtterance).speakingRate,
        markupUsed: utterance.text,
        inputMode: "text" as const,
        utterance: i,
        pauseBeforeMs: PAUSE_MS[adapted.ttsHints.pauseBefore],
        emphasisNotFound: adapted.emphasisTerms.filter(
          (term) => !adapted.targetText.includes(term)
        ),
        // No inline pause any more: it restarted the voice (see the header).
        emphasisPausedTerm: null,
        // Gemini TTS is directed to lean on these; Chirp 3 HD cannot be.
        emphasisNotRealized: spokenBy === "gemini" ? [] : present,
      };
    })
  );

  const spokenChars = adaptation.segments.reduce(
    (total, segment) => total + countSpokenChars(segment.targetText),
    0
  );
  const naturalSec = chosen.reduce((total, entry) => total + entry.durationSec, 0);

  const synthesis = Synthesis.parse({
    audioUri: outputMp3,
    durationSec,
    // Every voice that actually spoke, in order of first use: one for most
    // clips, one per speaker in a dialogue, plus a Chirp fallback if there was one.
    voice: [...new Set(chosen.map((entry) => entry.voice))].join(" + "),
    segments,
    utterances,
    sourceDurationSec,
    billedChars: utterances.reduce(
      (total, utterance) => total + utterance.billedChars,
      0
    ),
    // Over the kept takes as spoken, before any re-time. Each was asked for
    // the pace its teacher took, so this is how fast THIS clip's Hindi is said,
    // and the voice's own rate only where the pace asked for was `natural`.
    measuredCharsPerSec: spokenChars / naturalSec,
  });

  return {
    synthesis,
    utteranceFiles: kept.map((entry) => entry.file),
    masterFile: masterWav,
  };
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
