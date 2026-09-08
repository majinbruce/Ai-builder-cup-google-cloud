import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { probeDurationSec } from "../lib/ffmpeg.ts";
import {
  TTS_FALLBACK_VOICE,
  TTS_VOICE,
  listVoices,
  synthesize,
  type TtsInput,
} from "../lib/tts.ts";
import { Adaptation } from "../modules/localize/localize.schemas.ts";
import { fail, out, readStageOutput } from "./print.ts";

/**
 * ============================================================================
 * The Phase 3 spike. docs/SPEC.md section f says do this BEFORE writing stage 4.
 * ============================================================================
 *
 *   npm run spike:tts
 *
 * docs/research.md carries a row marked **SSML — CONFLICT**: the 2025-10-17
 * release note says Chirp 3 HD SSML supports only <phoneme>, <p>, <s>, <sub> and
 * <say-as>; the current Chirp 3 HD page also lists <prosody> and <break>; the
 * voice-list page says Chirp 3 HD "doesn't support SSML input" at all. Three
 * Google pages, three answers. SPEC section b's synthesis design is conditional
 * on which one is true ("+ SSML prosody if the Phase 3 spike confirms Chirp 3 HD
 * honors it"), so the phase opens by measuring rather than by picking.
 *
 * The measurement is duration. An HTTP 200 proves only that the request was
 * accepted — a voice that silently ignores <emphasis> returns 200 and audio that
 * is byte-for-byte the length of the plain-text version. So every variant is
 * ffprobe'd and compared against variant 1, and a tag that changes nothing is
 * reported as ignored no matter what the status code said.
 *
 * Variant 6 is the control and is the reason this spike can conclude anything.
 * It sends the SAME SSML to hi-IN-Neural2-D, which documents full SSML support.
 * If Chirp ignores the tag and Neural2 honours it, the finding is about Chirp.
 * If neither moves, the finding is about our request and the spike has caught
 * its own bug instead of publishing it as a Google one.
 *
 * The Hindi is read from outputs/adaptation.json rather than hard-coded, so the
 * result is about the text this pipeline actually synthesizes.
 *
 * EVERY VARIANT RUNS N TIMES, and that is the most important line in this file.
 * The first version of this spike ran each variant once and reported that all of
 * them "changed the audio". Re-running it produced 11.760s and then 11.240s for
 * the SAME markup input — a 4.4% swing from nothing but a second request. Chirp
 * 3 HD is a generative model and its output duration is not reproducible, so a
 * one-shot A/B is measuring noise as confidently as it measures signal. The
 * threshold an effect has to clear is therefore DERIVED from the baseline's own
 * spread across trials rather than picked in advance, and any effect smaller
 * than the noise is reported as unresolved instead of as a finding.
 */

const OUT_DIR = "outputs/spike";

/** XML-escapes text going inside an SSML element. */
export function escapeSsml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const adaptation = Adaptation.parse(
  readStageOutput<{ adaptation: unknown }>(
    "outputs/adaptation.json",
    "npm run pipeline -- --no-audio"
  ).adaptation
);

const subject = adaptation.segments[0];
if (subject === undefined) fail("outputs/adaptation.json has no segments.");

const sentence = subject.targetText;

/** Hoisted for the same closure-narrowing reason as `emphasisTerm` below. */
const emphasisTermsInOrder: string[] = subject.emphasisTerms;

/**
 * The first emphasis term that actually occurs in the Hindi.
 *
 * Defaulted to "" rather than left possibly-undefined because fail()'s `never`
 * return does not narrow a const inside the closures below. An empty string is
 * unreachable past the guard, and it keeps the helpers honestly typed without a
 * cast.
 */
const emphasisTerm =
  subject.emphasisTerms.find((term) => sentence.includes(term)) ?? "";

if (emphasisTerm === "") {
  fail(
    `Segment ${subject.id} has no emphasis term present in its own targetText, so ` +
      "there is nothing to wrap. Re-run stage 2 or pick another segment."
  );
}

/** The sentence with `insert` placed immediately before the emphasis term. */
function withMarkerBeforeTerm(insert: string): string {
  return sentence.replace(emphasisTerm, `${insert}${emphasisTerm}`);
}

/** The SSML sentence with `insert` placed immediately before the emphasis term. */
function withMarkerBeforeTermSsml(insert: string): string {
  return `<speak>${escapeSsml(sentence).replace(
    escapeSsml(emphasisTerm),
    `${insert}${escapeSsml(emphasisTerm)}`
  )}</speak>`;
}

/** The sentence with the FIRST TWO emphasis terms each wrapped in `open`/</prosody>. */
function withTwoTermsWrapped(open: string): string {
  let body = escapeSsml(sentence);
  for (const term of emphasisTermsInOrder.slice(0, 2)) {
    const escaped = escapeSsml(term);
    if (!body.includes(escaped)) continue;
    body = body.replace(escaped, `${open}${escaped}</prosody>`);
  }
  return `<speak>${body}</speak>`;
}

/** The sentence with the emphasis term wrapped in an SSML element. */
function withTermWrapped(open: string, close: string): string {
  return `<speak>${escapeSsml(sentence).replace(
    escapeSsml(emphasisTerm),
    `${open}${escapeSsml(emphasisTerm)}${close}`
  )}</speak>`;
}

interface Variant {
  id: string;
  what: string;
  settles: string;
  voice: string;
  input: TtsInput;
  speakingRate?: number;
}

const variants: Variant[] = [
  {
    id: "01-text-baseline",
    what: "plain text, rate 1.0",
    settles: "the baseline every other duration is measured against",
    voice: TTS_VOICE,
    input: { mode: "text", content: sentence },
  },
  {
    id: "02-text-rate085",
    what: "plain text, speaking_rate 0.85",
    settles: "that speaking_rate is honoured, and by how much",
    voice: TTS_VOICE,
    input: { mode: "text", content: sentence },
    speakingRate: 0.85,
  },
  {
    id: "03-markup-pause",
    what: "markup, [pause long] before the emphasis term",
    settles: "that [pause] markup lands on hi-IN (research.md says it does)",
    voice: TTS_VOICE,
    input: { mode: "markup", content: withMarkerBeforeTerm("[pause long] ") },
  },
  {
    id: "04-ssml-emphasis",
    what: `ssml, <emphasis level="strong"> around "${emphasisTerm}"`,
    settles: "THE OPEN SPEC section g QUESTION",
    voice: TTS_VOICE,
    input: {
      mode: "ssml",
      content: withTermWrapped('<emphasis level="strong">', "</emphasis>"),
    },
  },
  {
    id: "05-ssml-prosody",
    what: 'ssml, <prosody rate="slow"> around the emphasis term',
    settles: "ditto, on the other tag SPEC section b names",
    voice: TTS_VOICE,
    input: {
      mode: "ssml",
      content: withTermWrapped('<prosody rate="slow">', "</prosody>"),
    },
  },
  {
    id: "06-ssml-neural2-control",
    what: `the SAME <prosody> ssml, but on ${TTS_FALLBACK_VOICE}`,
    settles: "THE VOICE CONTROL — proves a null result is about Chirp, not our request",
    voice: TTS_FALLBACK_VOICE,
    input: {
      mode: "ssml",
      content: withTermWrapped('<prosody rate="slow">', "</prosody>"),
    },
  },
  /**
   * 07 and 08 were added after the first run, which is the whole reason a spike
   * is a script and not a paragraph.
   *
   * That run had every variant "CHANGED the audio", including <prosody
   * rate="slow"> on two words adding 17.7% to an eleven-second sentence. Slowing
   * two words out of thirty-five cannot cost two seconds. A duration that moves
   * by far MORE than the tag could explain is not evidence the tag worked — it
   * is evidence something else is going on, and the obvious candidate is the
   * voice reading the tag out loud.
   *
   * These two separate those cases:
   *
   *   07 is the SSML baseline. <speak> wrapper, no inner tags. Comparing 04/05
   *      against 01 conflates "the tag did something" with "ssml mode itself
   *      does something"; comparing them against 07 does not.
   *   08 is the bogus-tag control. <zzz> has no meaning in SSML. If it moves the
   *      duration the same way <emphasis> does, then tags are being VOCALIZED or
   *      mishandled rather than interpreted, and every "CHANGED the audio"
   *      verdict above it is worthless.
   */
  {
    id: "07-ssml-plain-baseline",
    what: "ssml, <speak> wrapper only, no inner tags",
    settles: "the SSML baseline — isolates the tag from the mode",
    voice: TTS_VOICE,
    input: { mode: "ssml", content: `<speak>${escapeSsml(sentence)}</speak>` },
  },
  {
    id: "08-ssml-bogus-tag",
    what: "ssml, a meaningless <zzz> around the emphasis term",
    settles: "THE TAG CONTROL — if this moves too, tags are spoken, not honoured",
    voice: TTS_VOICE,
    input: { mode: "ssml", content: withTermWrapped("<zzz>", "</zzz>") },
  },
  /**
   * 09 and 10 test a PREDICTED MAGNITUDE, which is the only thing that settles
   * this. They were added after the second run, for a reason worth stating.
   *
   * That run cleared <emphasis> at +12.3% and <prosody rate="slow"> at +17.6%
   * over a 9.1% noise floor, and concluded SSML was honoured. But the magnitude
   * is physically wrong: <prosody rate="slow"> wrapped TWO words of a
   * thirty-five word sentence. Slowing two words to ~0.8x should add roughly
   * 0.15 s, about 1.4% — not 1.9 s. An effect in the right direction and an
   * order of magnitude too large is not a confirmation, it is a second anomaly,
   * and "it changed" was never the same claim as "it was interpreted".
   *
   *   09 makes a NUMERIC prediction. <break time="3s"/> has exactly one correct
   *      behaviour: three seconds of silence, ~27% on this sentence, ten times
   *      the noise floor. A parser that honours it cannot miss by much, and one
   *      that does not cannot hit. This is the variant that can actually be
   *      wrong.
   *   10 tests SCOPE. The same <prosody rate="slow"> wrapped around the WHOLE
   *      sentence instead of two words. If honoured, it must be far larger than
   *      05. If 10 and 05 are the same, the tag's scope is not being read, which
   *      means neither is the tag.
   */
  {
    id: "09-ssml-break-3s",
    what: 'ssml, <break time="3s"/> before the emphasis term',
    settles: "THE PREDICTION — honouring it means +3.0s, near enough exactly",
    voice: TTS_VOICE,
    input: { mode: "ssml", content: withMarkerBeforeTermSsml('<break time="3s"/>') },
  },
  {
    id: "10-ssml-prosody-whole",
    what: 'ssml, <prosody rate="slow"> around the ENTIRE sentence',
    settles: "THE SCOPE TEST — must dwarf 05 if the tag's extent is being read",
    voice: TTS_VOICE,
    input: {
      mode: "ssml",
      content: `<speak><prosody rate="slow">${escapeSsml(sentence)}</prosody></speak>`,
    },
  },
  /**
   * 11 and 12 are the variants that actually resolved this, and they were added
   * third — after a run whose verdict was WRONG. That is worth recording rather
   * than quietly overwriting.
   *
   * The second run concluded "SSML is genuinely honoured" on the strength of the
   * <break time="3s"/> prediction landing and a bogus <zzz> staying inert. Both
   * of those observations were correct. The conclusion drawn from them was not,
   * because neither one distinguishes "the tag's MEANING was applied" from "the
   * presence of a tag changed the audio". Nothing in the design tested the
   * former, and the stage built on that verdict inserted sixteen <prosody>
   * wrappers and made the fixture 37% longer, which is how the error surfaced.
   *
   *   11 is the NO-OP CONTROL, and it is the single most informative request in
   *      this file. `<prosody rate="1.0">` is semantically nothing: it asks for
   *      the rate the voice already uses. If it changes the duration, then the
   *      tag's VALUE is not being read and every rate-based reading of 05 and 10
   *      is an artifact. A rate tag that does something when it asks for nothing
   *      is not being honoured, whatever else is true.
   *   12 tests whether the effect scales with TAG COUNT rather than with what the
   *      tags say. Two wrappers versus one, same rate. If the cost doubles, each
   *      tag is inserting time at its own position and the rate is irrelevant.
   *
   * A prediction test tells you a parser exists. A no-op test tells you what it
   * parses. This spike needed both and originally had only the first.
   */
  {
    id: "11-ssml-prosody-noop",
    what: 'ssml, <prosody rate="1.0"> — a semantic NO-OP — around the term',
    settles: "THE NO-OP CONTROL — if this moves, the rate VALUE is not being read",
    voice: TTS_VOICE,
    input: { mode: "ssml", content: withTermWrapped('<prosody rate="1.0">', "</prosody>") },
  },
  {
    id: "12-ssml-prosody-twice",
    what: 'ssml, TWO <prosody rate="0.85"> wrappers instead of one',
    settles: "TAG-COUNT SCALING — doubling means each tag inserts time of its own",
    voice: TTS_VOICE,
    input: { mode: "ssml", content: withTwoTermsWrapped('<prosody rate="0.85">') },
  },
  /**
   * 13 and 14 check the fallback SPEC section b names, because a spike that only
   * disqualifies the primary mechanism has not finished its job.
   *
   * research.md records `[pause short|long]` markup as "available for hi-IN" from
   * the Chirp 3 HD docs. 13 tests it in the position the stage would actually use
   * it — at the start of the utterance, realizing a segment's `pauseBefore` — and
   * 14 gives <break> the same treatment for comparison. Whichever of the two
   * measurably produces the silence it asks for is the one the stage should use.
   */
  {
    id: "13-markup-pause-leading",
    what: "markup, [pause short] at the START of the utterance",
    settles: "the fallback pause mechanism, in the position the stage uses it",
    voice: TTS_VOICE,
    input: { mode: "markup", content: `[pause short] ${sentence}` },
  },
  {
    id: "14-ssml-break-leading",
    what: 'ssml, <break time="350ms"/> at the START of the utterance',
    settles: "the same pause, via the other mechanism, for a head-to-head",
    voice: TTS_VOICE,
    input: {
      mode: "ssml",
      content: `<speak><break time="350ms"/>${escapeSsml(sentence)}</speak>`,
    },
  },
];

/** How many times each variant is synthesized. Three is the minimum that can
 * show a spread at all; more would buy precision this decision does not need. */
const TRIALS = 3;

interface Trial {
  durationSec: number;
  latencyMs: number;
  bytes: number;
}

interface Result {
  variant: Variant;
  trials: Trial[];
  meanSec: number;
  minSec: number;
  maxSec: number;
  /** (max - min) / mean, this variant's own reproducibility. */
  spread: number;
  billedChars: number;
  error: string | null;
}

out();
out("  Phase 3 spike — what does Chirp 3 HD actually honour?");
out(`  voice     ${TTS_VOICE}   control: ${TTS_FALLBACK_VOICE}`);
out(`  segment   ${subject.id} from outputs/adaptation.json`);
out(`  emphasis  "${emphasisTerm}"`);
out(`  trials    ${TRIALS} per variant (Chirp is generative; one sample is not a measurement)`);
out(`  sentence  ${sentence}`);
out();

const available = await listVoices();
for (const voice of [TTS_VOICE, TTS_FALLBACK_VOICE]) {
  if (!available.includes(voice)) {
    fail(`Voice ${voice} is not in the ${available.length} voices hi-IN offers.`);
  }
}
out(`  preflight ${available.length} hi-IN voices reachable, both spike voices present`);
out();

fs.mkdirSync(OUT_DIR, { recursive: true });

const results: Result[] = [];

for (const variant of variants) {
  process.stdout.write(`  ${variant.id.padEnd(26)} `);

  const trials: Trial[] = [];
  let error: string | null = null;

  for (let trial = 0; trial < TRIALS; trial += 1) {
    try {
      const result = await synthesize({
        input: variant.input,
        voice: variant.voice,
        ...(variant.speakingRate === undefined
          ? {}
          : { speakingRate: variant.speakingRate }),
      });

      // Only the first trial's audio is kept: the files exist to be listened
      // to, and three near-identical takes of each variant would make the
      // directory harder to review rather than more informative.
      const file = path.join(
        OUT_DIR,
        trial === 0 ? `${variant.id}.wav` : `${variant.id}.trial${trial + 1}.wav`
      );
      fs.writeFileSync(file, result.audio);
      const durationSec = await probeDurationSec(file);
      if (trial > 0) fs.rmSync(file);

      trials.push({
        durationSec,
        latencyMs: result.latencyMs,
        bytes: result.audio.byteLength,
      });
      process.stdout.write(`${durationSec.toFixed(3)}s `);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      error = message.split("\n")[0] ?? message;
      process.stdout.write(`REJECTED `);
      break;
    }
  }

  const durations = trials.map((trial) => trial.durationSec);
  const meanSec =
    durations.length === 0
      ? 0
      : durations.reduce((sum, value) => sum + value, 0) / durations.length;
  const minSec = durations.length === 0 ? 0 : Math.min(...durations);
  const maxSec = durations.length === 0 ? 0 : Math.max(...durations);

  results.push({
    variant,
    trials,
    meanSec,
    minSec,
    maxSec,
    spread: meanSec === 0 ? 0 : (maxSec - minSec) / meanSec,
    billedChars: variant.input.content.length * Math.max(1, trials.length),
    error,
  });

  out(error === null ? `| mean ${meanSec.toFixed(3)}s` : `| ${error}`);
}

/* -------------------------------------------------------------------------- */
/* The noise floor, measured before anything is called a finding              */
/* -------------------------------------------------------------------------- */

const byId = (id: string): Result | undefined =>
  results.find((entry) => entry.variant.id === id);

const plainBaseline = byId("01-text-baseline");
const ssmlBaseline = byId("07-ssml-plain-baseline");

if (plainBaseline === undefined || plainBaseline.trials.length === 0) {
  fail("The baseline variant failed, so nothing can be compared against it.");
}

/**
 * The threshold an effect must clear to count, derived rather than chosen.
 *
 * It is the largest same-input spread observed anywhere in this run. If asking
 * for the identical audio twice can move the duration by X%, then a variant that
 * differs by less than X% has not demonstrated anything, whatever its p-value
 * would look like with three samples. Taking the max across all variants rather
 * than the baseline's alone is the conservative choice: it cannot be gamed by a
 * baseline that happened to be stable.
 */
const noiseFloor = Math.max(...results.map((result) => result.spread));

out();
out("  --- reproducibility first: how much does the SAME input move? ---");
out();
for (const result of results) {
  if (result.trials.length < 2) continue;
  out(
    `  ${result.variant.id.padEnd(26)} ${result.minSec.toFixed(3)}s .. ` +
      `${result.maxSec.toFixed(3)}s   spread ${(result.spread * 100).toFixed(1)}%`
  );
}
out();
out(
  `  Noise floor = ${(noiseFloor * 100).toFixed(1)}% — the largest swing produced by ` +
    "re-sending identical input."
);
out("  Nothing below that is a finding, no matter how good the table looks.");
out();

/* -------------------------------------------------------------------------- */
/* The comparison                                                             */
/* -------------------------------------------------------------------------- */

out("  --- measured (mean of trials; a 200 proves nothing on its own) ---");
out();
out("  variant                      mean    vs baseline  verdict");

for (const result of results) {
  const { variant } = result;

  if (result.trials.length === 0) {
    out(
      `  ${variant.id.padEnd(26)} ${"—".padStart(9)}   ${"—".padStart(11)}  ` +
        `REJECTED: ${result.error ?? ""}`
    );
    continue;
  }

  // An SSML variant is compared against the SSML baseline, not the plain-text
  // one, so "the tag did something" is not conflated with "the <speak> wrapper
  // did something".
  const isChirpSsml = variant.input.mode === "ssml" && variant.voice === TTS_VOICE;
  const against =
    isChirpSsml && ssmlBaseline !== undefined && ssmlBaseline.meanSec > 0
      ? ssmlBaseline.meanSec
      : plainBaseline.meanSec;

  const delta = (result.meanSec - against) / against;
  const moved = Math.abs(delta) >= noiseFloor;

  const verdict =
    variant.id === "01-text-baseline"
      ? "plain-text baseline"
      : variant.id === "07-ssml-plain-baseline"
        ? `SSML baseline (${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}% vs plain text)`
        : moved
          ? "CHANGED the audio, beyond noise"
          : "no effect distinguishable from noise";

  out(
    `  ${variant.id.padEnd(26)} ${`${result.meanSec.toFixed(3)}s`.padStart(9)}   ` +
      `${`${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`.padStart(11)}  ${verdict}`
  );
}

/* -------------------------------------------------------------------------- */
/* What the controls license us to say                                        */
/* -------------------------------------------------------------------------- */

const bogus = byId("08-ssml-bogus-tag");
const emphasis = byId("04-ssml-emphasis");
const prosody = byId("05-ssml-prosody");
const control = byId("06-ssml-neural2-control");

out();
out("  --- what the controls say ---");
out();

if (
  ssmlBaseline === undefined ||
  bogus === undefined ||
  emphasis === undefined ||
  prosody === undefined ||
  ssmlBaseline.meanSec === 0
) {
  out("  A control variant failed, so no conclusion is available. Do not invent one.");
} else {
  const rel = (result: Result): number =>
    (result.meanSec - ssmlBaseline.meanSec) / ssmlBaseline.meanSec;

  const bogusDelta = rel(bogus);
  const emphasisDelta = rel(emphasis);
  const prosodyDelta = rel(prosody);
  const bogusMoved = Math.abs(bogusDelta) >= noiseFloor;

  out(
    `  vs the SSML baseline: <zzz> ${(bogusDelta * 100).toFixed(1)}%, ` +
      `<emphasis> ${(emphasisDelta * 100).toFixed(1)}%, ` +
      `<prosody rate="slow"> ${(prosodyDelta * 100).toFixed(1)}%. ` +
      `Noise floor ${(noiseFloor * 100).toFixed(1)}%.`
  );
  out();

  /**
   * The no-op control outranks everything else in this file.
   *
   * `<prosody rate="1.0">` asks for the rate the voice already uses, so a
   * correct implementation produces audio indistinguishable from no tag at all.
   * If it moves the duration, the tag's VALUE is not being read — and then every
   * rate-shaped reading of the other variants is an artifact of the tag's
   * presence rather than evidence of prosody. This is the test the first two
   * runs of this spike lacked, and it is the one that reversed their verdict.
   */
  const noop = byId("11-ssml-prosody-noop");
  const twice = byId("12-ssml-prosody-twice");
  const breakVariant = byId("09-ssml-break-3s");
  const wholeProsody = byId("10-ssml-prosody-whole");

  const relOrNull = (result: Result | undefined): number | null =>
    result === undefined || result.meanSec === 0
      ? null
      : (result.meanSec - ssmlBaseline.meanSec) / ssmlBaseline.meanSec;

  const noopDelta = relOrNull(noop);
  const twiceDelta = relOrNull(twice);

  /* The prediction test: <break time="3s"/> has one correct magnitude. */
  const PREDICTED_BREAK_SEC = 3.0;
  const PREDICTION_TOLERANCE = 0.25;

  let breakHonoured: boolean | null = null;

  if (breakVariant !== undefined && breakVariant.meanSec > 0) {
    const observed = breakVariant.meanSec - ssmlBaseline.meanSec;
    breakHonoured =
      Math.abs(observed - PREDICTED_BREAK_SEC) / PREDICTED_BREAK_SEC <=
      PREDICTION_TOLERANCE;
    out(
      `  PREDICTION  <break time="3s"/> should add ${PREDICTED_BREAK_SEC.toFixed(1)}s. ` +
        `Measured +${observed.toFixed(2)}s -> ${breakHonoured ? "HIT" : "MISS"}.`
    );
  }

  if (noopDelta !== null) {
    out(
      `  NO-OP       <prosody rate="1.0"> should add nothing. Measured ` +
        `${noopDelta >= 0 ? "+" : ""}${(noopDelta * 100).toFixed(1)}% -> ` +
        `${Math.abs(noopDelta) >= noiseFloor ? "IT MOVED, so the rate value is ignored" : "inert, as it should be"}.`
    );
  }

  if (noopDelta !== null && twiceDelta !== null && Math.abs(noopDelta) > 0.001) {
    const ratio = twiceDelta / Math.max(0.001, prosodyDelta);
    out(
      `  TAG COUNT   two <prosody> wrappers vs one = ${ratio.toFixed(2)}x the effect. ` +
        `~2x means each tag inserts time at its own position.`
    );
  }

  if (wholeProsody !== undefined && wholeProsody.meanSec > 0) {
    const wholeDelta = relOrNull(wholeProsody) ?? 0;
    const twoWordDelta = prosodyDelta;
    out(
      `  SCOPE       <prosody> over the whole sentence is ` +
        `${(wholeDelta / Math.max(0.001, twoWordDelta)).toFixed(2)}x the two-word version. ` +
        "Honouring scope means MUCH greater than 1."
    );
  }

  const pauseMarkup = byId("13-markup-pause-leading");
  const breakLeading = byId("14-ssml-break-leading");

  if (pauseMarkup !== undefined && pauseMarkup.meanSec > 0) {
    const delta = (pauseMarkup.meanSec - plainBaseline.meanSec) / plainBaseline.meanSec;
    out(
      `  FALLBACK    [pause short] leading: ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}% ` +
        `-> ${Math.abs(delta) >= noiseFloor ? "produces silence" : "produces NO measurable silence"}.`
    );
  }
  if (breakLeading !== undefined && breakLeading.meanSec > 0) {
    const observed = breakLeading.meanSec - ssmlBaseline.meanSec;
    out(
      `  FALLBACK    <break time="350ms"/> leading: +${observed.toFixed(2)}s for 0.35s ` +
        "requested -> the mechanism the stage should use for pauseBefore."
    );
  }

  out();

  const noopMoved = noopDelta !== null && Math.abs(noopDelta) >= noiseFloor;

  if (noopMoved) {
    out("  VERDICT, and it reverses this spike's own earlier conclusion:");
    out();
    out("  Chirp 3 HD on hi-IN parses SSML STRUCTURE but does not apply inline");
    out("  <prosody>'s rate. A tag asking for rate 1.0 — semantically nothing —");
    out("  changed the duration as much as one asking for 'slow', and adding a second");
    out("  wrapper roughly doubled the cost. So each inline tag inserts time at its");
    out("  own position and the rate attribute is ignored. <break> works because");
    out("  inserting time IS what <break> means; <prosody> 'working' was the same");
    out("  artifact wearing a different name.");
    out();
    out("  CONSEQUENCE for stage 4: inline <prosody>/<emphasis> CANNOT realize");
    out("  per-term stress on this voice, and using it does active harm — it drops a");
    out("  ~1.4s hole beside every stressed word while stressing nothing. What is");
    out("  left, and is measured to work: audioConfig speaking_rate for the segment,");
    out("  and <break time> for a pause. That is SPEC section b's FALLBACK branch,");
    out("  reached on evidence rather than on the documentation conflict.");
  } else if (bogusMoved) {
    out("  VERDICT: tags are NOT being interpreted. A tag SSML does not define moved");
    out("  the duration as much as one it does, which is what happens when markup is");
    out("  mangled rather than parsed. Do not use SSML for emphasis on this voice.");
  } else if (breakHonoured === true) {
    out("  VERDICT: the no-op tag is inert, the bogus tag is inert, and the 3s break");
    out("  landed within tolerance of its predicted magnitude. Inline SSML prosody is");
    out("  genuinely honoured on this voice. Confirm by ear before relying on it.");
  } else {
    out("  VERDICT: UNRESOLVED. Do not build on SSML prosody until this resolves.");
  }

  out();
  if (control !== undefined && control.meanSec > 0 && plainBaseline.meanSec > 0) {
    out();
    out(
      `  Voice control: the same <prosody> SSML on ${TTS_FALLBACK_VOICE} runs ` +
        `${(((control.meanSec - plainBaseline.meanSec) / plainBaseline.meanSec) * 100).toFixed(1)}% ` +
        "vs Chirp's plain baseline."
    );
    out("  Two different voices are not a controlled comparison of tag handling, so");
    out("  this row bounds the fallback's cost rather than proving the tag worked.");
  }
}

out();
out(`  WAVs in ${OUT_DIR}/ — listen before trusting any row above.`);
out("  Duration catches a tag that does nothing to length. It does NOT catch a tag");
out("  that changes pitch or loudness alone, which is part of what <emphasis> is");
out("  supposed to do — so a null result here is 'no measurable effect', not proof");
out("  of total inertness. That distinction is kept in docs/research.md too.");
out();

const totalBilled = results.reduce((sum, result) => sum + result.billedChars, 0);
const totalRequests = results.reduce((sum, result) => sum + result.trials.length, 0);
out(`  spike cost: ${totalBilled} billed characters across ${totalRequests} requests.`);
out();

fs.writeFileSync(
  path.join(OUT_DIR, "spike-results.json"),
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      voice: TTS_VOICE,
      controlVoice: TTS_FALLBACK_VOICE,
      trials: TRIALS,
      segmentId: subject.id,
      sentence,
      emphasisTerm,
      plainBaselineSec: plainBaseline.meanSec,
      ssmlBaselineSec: ssmlBaseline?.meanSec ?? null,
      noiseFloor,
      results: results.map((result) => ({
        id: result.variant.id,
        what: result.variant.what,
        voice: result.variant.voice,
        mode: result.variant.input.mode,
        sent: result.variant.input.content,
        speakingRate: result.variant.speakingRate ?? 1.0,
        durationsSec: result.trials.map((trial) => trial.durationSec),
        meanSec: result.meanSec,
        spread: result.spread,
        latencyMs: result.trials.map((trial) => trial.latencyMs),
        billedChars: result.billedChars,
        error: result.error,
      })),
    },
    null,
    2
  )
);

out(`  written -> ${OUT_DIR}/spike-results.json`);
out();
