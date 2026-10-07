# SPEC — Intent-Preserving Localization for Educational Audio

AI Builder Cup 2026 (JAPAC) · Theme: **Media, Content & Digital Experiences** ·
Deadline **4 Oct 2026** · Team: Omkar (build) + designer (UI, deck, video).

Source of truth for scope. `CLAUDE.md` points here. Verified doc links and quotas
live in `docs/research.md`; cite that file rather than memory.

---

## a. Problem and differentiator

Educational English audio and video (MOOC lectures, tech explainers, corporate
training) reaches JAPAC learners either untranslated or through literal dubbing
that flattens everything a good teacher does with their voice: the stress on a
key term, the slow-down before a definition, the "this part matters" shift before
a warning, the idiom that makes an abstraction stick. Existing localization
pipelines optimize for lexical accuracy and lose the instructional layer, so the
localized version is *understandable* but no longer *teaches as well*.

**Differentiator, one sentence:** we detect and preserve the *pedagogical signal*
(what the teacher defined, stressed, warned about, exemplified and recapped, and
how they paced it) through adaptation and synthesis, and every non-literal choice
carries an auditable rationale plus an independent back-translation fidelity
score, so an educator can trust and correct the machine's judgment.

---

## b. Pipeline stages and schemas

Linear service, one job, five stages. No ADK: a sequential chain with fixed
schemas is a function pipeline, and a framework would add surface without adding
capability (see `docs/research.md` § ADK).

All schemas are Zod, in `src/modules/localize/localize.schemas.ts`. The same Zod
object is (1) converted with `z.toJSONSchema()` into the Gemini
`response_format.schema`, (2) used to `.parse()` the returned JSON, and (3) the
API response serializer. One definition, three consumers.

Gemini calls go through the **Interactions API** (`client.interactions.create`)
on `gemini-3.8-flash`. Prompts live in `src/prompts/<stage>.v1.md`.

```
upload/URL ─▶ ingest ─▶ analyze ─▶ adapt ─▶ critique ─┬─▶ synthesize ─▶ present
                         (Gemini,   (Gemini)  (Gemini)  │
                          audio in)                     └─ regen failing
                                                           segments once
```

### Shared enums

```ts
export const PedagogicalSignal = z.enum([
  "definition", "key_term", "example", "warning",
  "emphasis_shift", "transition", "recap", "none",
]);
export const Register = z.enum([
  "neutral", "enthusiastic", "cautionary", "reassuring", "humorous", "urgent",
]);
export const Pace = z.enum(["slow", "normal", "fast"]);
export const ChoiceKind = z.enum([
  "idiom", "cultural_reference", "term_kept_english", "restructured",
  "added_clarifier", "register_shift",
]);
export const JobStatus = z.enum([
  "queued", "ingesting", "analyzing", "adapting", "critiquing",
  "synthesizing", "done", "failed",
]);
```

### Stage 0 — Ingest

Input: `audio/*` or `video/mp4`, ≤ 100 MiB, ≤ 180 s, or, NICE, a YouTube URL.
**Amended 2026-10-01:** the browser uploads straight to GCS — `POST /uploads`
returns a V4 signed PUT URL (15 min, `x-goog-content-length-range` in the
signature), then `POST /jobs/from-upload {uploadId}` ingests it — because Cloud
Run caps HTTP/1 request bodies at 32 MiB and a 2-minute 1080p mp4 is 30–60 MB
(`docs/research.md` § Cloud Run). The multipart route below remains for scripts
and tests and keeps that 32 MiB ceiling in production. An mp4 with a playable
video track keeps its footage as `jobs/<id>/source.mp4`; after stage 4 the
picture is copied (not re-encoded) under the Hindi audio as `output.mp4`, and
the job page plays both side by side. A mux failure leaves an audio-only result
rather than failing the job. The size cap is `@fastify/multipart`'s `limits.fileSize`, fed from
`config.limits.maxUploadBytes` — **not** Fastify's `bodyLimit`, which measurement
on 2026-09-07 showed does not apply to multipart at all (a 300 KB file passed a
1 KB `bodyLimit` with a 200, because the plugin consumes the raw stream itself).
Wiring the cap to `bodyLimit` would be a cap that silently does nothing. ffmpeg normalizes to 16 kHz mono MP3 (Gemini downsamples to 16 kbps
mono anyway, so nothing is lost and inline base64 stays under the 20 MB request
cap). Output stored in GCS at `jobs/<jobId>/source.mp3`.

```ts
export const IngestResult = z.object({
  jobId: z.uuid(),
  sourceUri: z.string(),          // gs://... or local path in CLI mode
  durationSec: z.number().positive().max(180),
  mimeType: z.literal("audio/mp3"),
});
```

### Stage 1 — Analyze (Gemini, audio in, JSON out)

One call. The model receives the audio plus `analyze.v1.md`, which asks for
segmentation at pedagogical boundaries (not fixed windows), and per segment the
annotations below. Segments target 4–12 s so a 90 s clip yields ~10–15 rows.

```ts
export const EmphasisMarker = z.object({
  term: z.string(),                       // verbatim from the transcript
  strength: z.enum(["moderate", "strong"]),
  evidence: z.string(),                   // "louder + pause after", "repeated twice"
});
export const IdiomOrReference = z.object({
  phrase: z.string(),
  literalMeaning: z.string(),
  intendedMeaning: z.string(),
  kind: z.enum(["idiom", "cultural_reference", "humor"]),
});
export const Speaker = z.object({         // added 2026-10-07
  id: z.string(),                         // "A", "B", in order of first appearance
  voice: z.enum(["female", "male", "unknown"]),  // how the voice SOUNDS
  description: z.string(),                // "the presenter, speaking to camera"
});
export const AnalyzedSegment = z.object({
  id: z.string(),                         // "s01"
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  speaker: z.string().optional(),         // a Speaker.id; one segment, one speaker
  text: z.string(),                       // English transcript
  signal: PedagogicalSignal,
  signalConfidence: z.number().min(0).max(1),
  signalEvidence: z.string(),             // why this label, in one sentence
  register: Register,
  pace: Pace,
  emphasis: z.array(EmphasisMarker),
  idioms: z.array(IdiomOrReference),
  keyTerms: z.array(z.string()),          // technical vocabulary to keep stable
});
export const Analysis = z.object({
  sourceLanguage: z.string(),             // "en"
  topic: z.string(),
  audience: z.string(),                   // "beginner developers", inferred
  speakers: z.array(Speaker).optional(),  // absent on jobs before 2026-10-07
  segments: z.array(AnalyzedSegment).min(1),
});
```

**Speakers (added 2026-10-07; was the NICE "speaker diarization").** Found on a
clip where a woman presents and a man answers one line: it came back as one
segment in one male voice, because no stage knew who was speaking. Stage 1 now
lists every distinct voice and how it sounds, names one per segment, and cuts
at every change of speaker (which wins over the 4–12 s target). Three things
read it, through `speakers.ts`: stage 2 writes Hindi whose first-person forms
agree with the speaker (बताती हूँ / बताता हूँ — the brief, the adapt input and
the critic's pair all carry it); stage 4 starts a new utterance when the
speaker changes and casts each speaker a voice of their own kind, different
from every other speaker's; and a line that is not the teacher's is directed
as that person, without the teacher's persona. `voice` records what is heard
and nothing more. A job with no `speakers` behaves exactly as before.

**Anchoring (added 2026-10-07, `anchor.ts`, `docs/research.md` § Cues and
phrases).** The model's `startSec`/`endSec` are not what later stages read. It
cuts in the teacher's pauses, as asked, but reports one timestamp somewhere
inside the silence and gives it to both neighbours — and stage 4 then started
the Hindi up to 1.5 s before the teacher resumed, while stage 2 budgeted the
pause as speaking time. After the call, and after corroboration has scored the
model's own timestamps, each edge that sits in a measured pause (within 0.15 s)
takes that pause's edge: a segment **ends where the pause starts and the next
one starts where it ends**. So in the stored `Analysis` a segment is the span
the teacher is speaking, segments are no longer contiguous, and the gap between
two is the teacher's measured silence. An edge with no pause near it keeps the
model's value; an anchor that would leave a span its own words could not be
said in (six words a second) is refused, and the END of the last segment is
never anchored: nothing follows it, and its line may use the closing silence.
What the model said instead is kept in `Corroboration.boundaryAnchors`, and
`boundariesAligned` is still counted on the model's values.

### Stage 2 — Adapt (Gemini, text in, JSON out)

Modelled on how a human localizer actually works, because a stateless
per-segment call is exactly the machine that produces flat, stiff output. A
human listens to the whole thing first, forms a picture of the topic and the
teacher, writes themselves a glossary so a term is the same word every time,
then *re-teaches* each point in Hindi rather than transcoding the sentence, and
finally reads it aloud to catch what sounds wrong. Three moves, not one:

**2a — the brief.** One small call over the whole `Analysis` (no segments
adapted yet) producing `AdaptationBrief`: topic, audience, the instructor's
persona, register guidance, and the **glossary**. The glossary lives at the
adaptation level, not per segment, because its entire job is consistency —
`closure` must not be one word in segment 3 and another in segment 11.

**2b — adapt.** Input: `Analysis` + `AdaptationBrief` + target language (`hi`) +
`adapt.v1.md`, walked in order with the previously adapted segment in context so
callbacks ("remember that word — idempotent") and terminology carry across rows.
The prompt makes the model translate *intent*, reproduce every `emphasis` term
with a marker, and explain each non-literal decision. Every segment must come
back; ids must match.

**Hinglish, in Devanagari.** Code-mixing is the real register of Indian tech
education and the prompt says so: technical vocabulary stays as the English
*concept*, Hindi carries the grammar and the teaching. But `targetText` is
**Devanagari only**, including transliterated terms (`क्लोज़र`), because that
string is what goes to Chirp 3 HD and embedded Latin script is an unverified
pronunciation risk on `hi-IN`. The English form travels separately in the
glossary, so the reasoning panel still shows the learner "closure" on screen.

**Register matches the speaker; fluency is non-negotiable.** A dry lecture stays
dry — that is what intent-preserving means, and inventing enthusiasm the speaker
never had would be editorializing, not localizing. What is not negotiable is
that the Hindi sound like a person actually speaking it. That is a fluency
requirement, enforced by the `naturalness` score in stage 3 rather than by
asking the prompt to "be engaging".

```ts
export const AdaptationChoice = z.object({
  kind: ChoiceKind,
  original: z.string(),
  adapted: z.string(),
  why: z.string(),                        // one or two sentences, learner-facing
});
export const GlossaryEntry = z.object({
  english: z.string(),                    // "closure"
  decision: z.enum(["transliterate", "translate", "keep_english_concept"]),
  targetForm: z.string(),                 // Devanagari, e.g. "क्लोज़र"
  why: z.string(),
});
export const AdaptationBrief = z.object({
  topic: z.string(),
  audience: z.string(),
  instructorPersona: z.string(),          // how this teacher sounds, in one or two sentences
  registerGuidance: z.string(),           // how to match THEM, not how to be lively
  glossary: z.array(GlossaryEntry),
});
export const AdaptedSegment = z.object({
  id: z.string(),
  targetText: z.string(),                 // Hindi, DEVANAGARI ONLY — this string goes to TTS
  literalText: z.string(),                // what a literal translation would say
  termsUsed: z.array(z.string()),         // glossary `english` keys appearing here, for the UI
  rationale: z.string(),                  // overall: how signal + register were kept
  emphasisTerms: z.array(z.string()),     // target-language tokens to stress in TTS
  choices: z.array(AdaptationChoice),
  ttsHints: z.object({
    speakingRate: z.number().min(0.7).max(1.3),   // from pace + signal
    pauseBefore: z.enum(["none", "short", "long"]),
    style: z.string(),                    // "warm, slow, stress 'closure'"
  }),
});
export const Adaptation = z.object({
  targetLanguage: z.string(),             // "hi"
  brief: AdaptationBrief,
  segments: z.array(AdaptedSegment).min(1),
});
```

### Stage 3 — Critique (Gemini, separate call, JSON out)

Input: original `AnalyzedSegment.text` + `AdaptedSegment.targetText` pairs plus
the signal labels, with `critique.v1.md`. The model back-translates each Hindi
segment *without seeing the English rationale or the brief*, then scores it on
two separate axes: **instructional fidelity** (does it still teach the same
thing?) and **naturalness** (would an Indian instructor say this out loud?),
quoting the specific stiff constructions it finds in `translationese[]`. The
second axis is the read-aloud pass a human translator does, and it is what stops
faithful-but-lifeless output from scoring well.

Segments with `fidelity < 70`, `naturalness < 70`, or `signalPreserved === false`
are sent back to Adapt **once** with the critique attached; the second result is
kept regardless (bounded loop, no runaway cost).

**On what this is and is not.** This is the same model family scoring output it
produced, so it is a *blind back-translation check*, not an independent review,
and the project says so rather than overclaiming. What blinding buys is real —
the critic cannot see the reasoning it is meant to be checking, so it cannot
launder a bad choice by reading its justification — but it is not independence.
The rubric is published and the raw scores are shown in the UI including the
failures, which is the honest form of the evidence.

```ts
export const SegmentCritique = z.object({
  id: z.string(),
  backTranslation: z.string(),
  fidelity: z.number().int().min(0).max(100),
  // Scored separately and on a different question: fidelity asks "does it still
  // teach the same thing", naturalness asks "would an Indian instructor say this
  // sentence out loud". A segment can be perfectly faithful and still be
  // unusable translationese, and only the second score catches that.
  naturalness: z.number().int().min(0).max(100),
  translationese: z.array(z.string()),    // specific stiff constructions, quoted
  signalPreserved: z.boolean(),
  emphasisPreserved: z.boolean(),
  issues: z.array(z.string()),
  suggestion: z.string().optional(),
});
export const Critique = z.object({
  overallFidelity: z.number().int().min(0).max(100),
  overallNaturalness: z.number().int().min(0).max(100),
  segments: z.array(SegmentCritique).min(1),
});
```

### Stage 4 — Synthesize (Gemini TTS, directed; Chirp 3 HD as the fallback)

**Reworked 2026-10-01** after listening to the deployed demo, and **again
2026-10-06** after listening to nine more clips — see `docs/research.md`
§ Synthesis rework and § The voice. The unit of speech is an **utterance**, not
a segment:

- Consecutive segments are grouped until one ends a sentence (`। ? ! .`); a
  segment with `pauseBefore` ≠ none, or the 5,000-byte input cap, starts a new
  one. One TTS call per utterance — and up to two more for a take that cannot
  be fitted to its time (Pace, below) — the Hindi as plain text with no tags.
- **The voice is Gemini TTS** (`TTS_ENGINE=gemini`, `GEMINI_TTS_MODEL`,
  `GEMINI_TTS_VOICE`), and since 2026-10-07 the model is
  **`gemini-3.8-flash-tts`** (stable; `gemini-3.1-flash-tts-preview` before).
  It is given the Hindi as its text and the delivery as ONE short style line
  built from the pipeline's own artifacts (`buildSpeechStyle`): who is speaking
  (the opening clause of the brief's `instructorPersona`, or the other speaker
  as stage 1 described them), the first segment's `register`, the pace (its
  words are in `src/prompts/pace.v1.md`; a first take is asked for the one
  `ttsHints.speakingRate` implies), the house phrase in
  `src/prompts/speak.v2.md`, and the Hindi `emphasisTerms` to lean on. This is where stage 1's reading of the
  teacher reaches the audio. Short on purpose: Google's guidance for the 3.8
  models is that long profiles and director's notes cause voice drift, and sent
  ours the model read them aloud (research, § Gemini 3.8 TTS). The older form —
  `speak.v1.md` plus full delivery notes, then the passage, as one prompt
  (`buildSpeechDirection`) — is still built and is what a 3.1 preview model is
  sent if `GEMINI_TTS_MODEL` names one; `lib/gemini.ts` picks the form from the
  model. The overall style and the voice are arguments
  (`SynthesizeInput.style`, `.geminiVoice`), not constants in a prompt.
- **One voice per speaker (2026-10-07).** `castVoices` gives the first woman
  heard the first name in `GEMINI_TTS_FEMALE_VOICES` (default `Kore,Aoede`), a
  second woman the next, and likewise `GEMINI_TTS_MALE_VOICES` (`Charon,Puck`);
  `GEMINI_TTS_VOICE` is for a voice stage 1 could not place and for older jobs.
  A voice repeats only when a pool runs out. The Chirp fallback follows the
  same cast, and `Synthesis.voice` lists every voice that spoke.
- An utterance the model fails, or returns at a length its
  text cannot explain, is spoken by the Chirp 3 HD voice of the same name
  (`hi-IN-Chirp3-HD-<voice>`; the two engines share voices), and the utterance
  records which `engine` spoke it. `TTS_ENGINE=chirp` runs everything on Chirp.
- **Pace, and a take recorded again (added 2026-10-07).** The first videos
  voiced by the 3.8 model showed the teacher's lips moving with nothing to
  hear. The Hindi was not short (85% of its budget; the rest of the teacher's
  time was "um" and "right?"); the voice was quick — 8.7 to 17.3 characters a
  second on single lines, asked for the same "natural" pace — and the re-time
  below can give a take back a tenth. So every take is **rehearsed** on its own
  cue (`rehearseTake`): re-timed, its phrases placed against the teacher's
  measured pauses the way the stage will place them, and what a viewer would
  be left watching measured. `silentSec` is the seconds the teacher is seen
  speaking with no Hindi over it, each stretch forgiven 0.4 s because a mouth
  moving that briefly is a pause (`silentLipsSec`); `lateSec` is how far behind
  its cue the NEXT line would start. A take that is too short for the teacher
  (by more than 0.3 s past the grace) or too long (next line over 0.2 s late)
  is recorded again at another pace from a four-step ladder — `brisk`,
  `natural`, `unhurried`, `slow` — picked by reading the first take as a
  measurement of how long THIS passage takes this voice (`retakePace`,
  `PACE_LENGTH`: ×0.9, ×1, ×1.15, ×1.5, measured). At most three takes of a
  line (`MAX_TAKES`); the one with the least `2 × lateSec + silentSec` is heard
  (`chooseTake`). The utterance records its `pace`, the teacher's `speechSec`,
  and every take when there was more than one — pace, length, `lateSec`,
  `silentSec`, and which was kept — so no choice of take is unexplained. A
  pace is a request, not a setting: one "unhurried" take came back shorter
  than the natural one, which is what the third take is for. Measured on five
  clips (research, § Pace): lines over while the teacher was still talking
  17 → 5, visible stretches of silent lips 33 → 21 (34.6 s → 17.7 s), lines
  behind their cue 3 → 0, for half as many TTS calls again. What is left is
  mostly the slower voice's own pauses mid-sentence, which went UP (12 → 16).
- **Timeline fit**: every take is trimmed of leading and trailing silence, so
  it starts on its cue. Each utterance starts at its source start, never
  earlier, or a breath (0.12 s) after the previous one if that ran long. One
  that would miss the next utterance's start is sped up, and one shorter than
  it should last is slowed, with ffmpeg `atempo` (pitch kept, ×0.9–×1.15),
  which is exact. How long it "should last" is what its rehearsal found leaves
  the teacher unheard for least, and it is not simply the teacher's speaking
  time: a take with a pause of its own where the teacher pauses waits there and
  needs no slowing at all, while one without has to talk through that pause
  and is slowed further. No overrun is tolerated: one that would not leave a
  breath before the next cue is sped up, however small (a 2% allowance used to
  start the next sentence up to 0.28 s late). The last utterance only has to
  end with the clip. `pauseBefore` no longer adds silence: the teacher's pause
  is already in the source timeline. The output is padded to the source's
  length.
- **Phrases (added 2026-10-07).** A take with time to spare is no longer one
  block that then waits. It is cut at its own pauses (≥ 0.25 s under −40 dBFS:
  where the voice ended a phrase), and a later phrase the Hindi reaches *ahead*
  of the teacher is held until the teacher's next measured pause ends, so the
  two start again together (`splitIntoPhrases`, `placePhrases`; the pauses come
  in as `SynthesizeInput.pauses`). Nothing is stretched or removed and no
  phrase moves earlier — a pause the voice chose becomes longer — and a hold
  never costs the next cue. Each held utterance records its `phrases` (start,
  length, `heldSec`), and then runs to its last phrase's end, past
  `measuredDurationSec`. Measured on stored takes: the worst stressed term went
  from 6.0 s ahead of the teacher to 2.8 s; the overall speech/silence overlap
  barely moves, and cannot — see research.
- Text too long for the voice to say in its slot is not left to the fit: the
  retry gate sends it back to adapt with the two numbers (`overLengthBudget`,
  stage 3). Two numbers, since anchoring. The **budget** is the teacher's
  speaking time (the segment's own span) and is what the adapter is asked for.
  The **ceiling** (`charCeiling`) is all that can be said before the next
  segment's cue with the ×1.15 speed-up spent, and is what it is sent back for
  missing. (The gate was "30% over" until 2026-10-07: more than stage 4 can
  absorb, and it let through a line that then ran 0.83 s into the next
  speaker's cue. The ceiling is deliberately NOT given to the adapter as a hard
  limit: tried once, it tripled the cost of adapt and stalled a retry —
  research, § Speakers and voices.)
- Emphasis **is** directed on the Gemini engine, and not on Chirp, which
  ignores `<prosody>` (Phase 3). `emphasisNotRealized` lists the terms only for
  utterances Chirp spoke. Nothing measures whether the stress was performed.

Audio comes back as LINEAR16, not MP3: per-segment MP3s inherit encoder padding
at every concat boundary, which would corrupt the duration measurements this
stage exists to produce. Segments are joined with ffmpeg's concat demuxer
(`-c copy`, lossless — measured within 0.11 s of the sum of its parts).

**The master (amended 2026-10-06, `docs/research.md` § Dub audit).** The join
is brought to the playback level (-16 LUFS) with ONE gain and a peak limiter,
and kept as a lossless 24 kHz WAV (`SynthesizeOutput.masterFile`). loudnorm's
`linear=true` was silently running in its dynamic mode on every dub, riding the
gain 2–3 dB from sentence to sentence. `jobs/<jobId>/output.mp3` is encoded from
the master at 24 kHz mono, and `output.mp4` is muxed from the master itself, so
the voice meets one lossy encoder, at its own rate. (It was a 16 kHz MP3
re-encoded to AAC: nothing above 8 kHz, two lossy passes.) Only ingest's
analysis copy, `source.mp3`, is 16 kHz. Full-SSML fallback voice if ever needed:
`hi-IN-Neural2-*`.

```ts
export const SynthesizedSegment = z.object({
  id: z.string(),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  voice: z.string(),
  speakingRate: z.number(),
  markupUsed: z.string(),                 // exact text/SSML sent, for the audit panel
  inputMode: z.enum(["text", "markup", "ssml"]),
  // Amended 2026-09-08, Phase 3. ffprobe'd from the returned audio, never
  // estimated: this field is what retires drift.ts's assumed chars/sec.
  measuredDurationSec: z.number().positive(),
  // Cloud TTS bills per REQUEST character, tags included. Stage 4 has no tokens,
  // so it emits no ModelCall — see the note on the ModelCall enum below.
  billedChars: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  pauseBeforeMs: z.number().int().nonnegative(),
  emphasisPausedTerm: z.string().nullable(),   // a pause, not stress
  emphasisNotRealized: z.array(z.string()),    // shown in the UI, silent in the audio
  emphasisNotFound: z.array(z.string()),       // claimed but absent from its own Hindi
});
// Added 2026-10-01; per-segment measuredDurationSec/billedChars/latencyMs became
// optional (they live here now), and old jobs without utterances still parse.
export const SynthesizedUtterance = z.object({
  index, segmentIds, sourceStartSec, deadlineSec, markupUsed, inputMode,
  requestedRate, speakingRate, naturalDurationSec, measuredDurationSec,
  refit, pauseBeforeMs, outputStartSec, billedChars, latencyMs,
});
export const Synthesis = z.object({
  audioUri: z.string(),
  durationSec: z.number().positive(),
  voice: z.string(),
  segments: z.array(SynthesizedSegment),
  utterances: z.array(SynthesizedUtterance).optional(),
  sourceDurationSec: z.number().positive().optional(),
  billedChars: z.number().int().nonnegative(),
  measuredCharsPerSec: z.number().positive(),
});
```

### Job envelope (Postgres row + API DTO)

```ts
export const ModelCall = z.object({
  // "smoke" is not a pipeline stage — it is the Phase 0 connectivity check. It
  // shares this enum so the telemetry path the real stages use is the one
  // exercised from the very first call this project makes.
  // "brief" is stage 2a, one call over the whole clip. Separate from "adapt"
  // (one call per segment) since 2026-09-08: pooling them made a whole-clip
  // call indistinguishable from a per-segment one, which section d's
  // per-segment cost footer cannot render honestly.
  stage: z.enum([
    "smoke", "analyze", "brief", "adapt", "critique", "adapt_retry",
    "synthesize",
  ]),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  // Measured 2026-09-07: `total_output_tokens` EXCLUDES thinking, which is
  // reported as `total_thought_tokens` and billed as output. Recorded separately
  // so a stage that is expensive because it thinks is distinguishable from one
  // that is expensive because it writes — the distinction the latency risk in
  // section g turns on, since thinking is the part `thinking_level` can buy back.
  thoughtTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
});
export const Job = z.object({
  id: z.uuid(),
  status: JobStatus,
  targetLanguage: z.string(),
  sourceUri: z.string().nullable(),
  error: z.string().nullable(),
  analysis: Analysis.nullable(),
  // Amended 2026-09-10, Phase 4. Stage 1's emphasis claims scored against
  // ffmpeg: section d item 2's "evidence on hover" shows the model's evidence
  // beside what was measured, and without this field it could show only the
  // former.
  corroboration: Corroboration.nullable(),
  adaptation: Adaptation.nullable(),
  critique: Critique.nullable(),
  // Amended 2026-09-10, Phase 4. Section d item 5 promises a "regenerated after
  // critique" badge and the Job had no field to draw it from. NB: the critique
  // scores a retried segment's FIRST draft; the panel says so.
  retriedIds: z.array(z.string()).nullable(),
  synthesis: Synthesis.nullable(),
  calls: z.array(ModelCall),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
```

Table `localize_jobs`: `id`, `user_id`, `status`, `target_language`,
`source_uri`, `error`, `analysis jsonb`, `corroboration jsonb`, `adaptation jsonb`,
`critique jsonb`, `retried_ids jsonb`, `synthesis jsonb`, `calls jsonb`,
`is_demo boolean`, timestamps. Stage outputs are opaque JSON
validated by the Zod schemas above at write and read.

### API surface (`src/modules/localize/`)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/localize/jobs` | multipart; 202 with `Job` in `status: queued`; 5 per user per hour |
| GET | `/api/v1/localize/jobs` | the caller's jobs, `JobSummary[]`, paginated |
| GET | `/api/v1/localize/jobs/:id` | poll; full `Job`; owner only (another user's id is a 404) |
| GET | `/api/v1/localize/jobs/:id/audio/:which` | `source` or `output`, streamed with HTTP Range (206) |
| POST | `/api/v1/localize/jobs/:id/segments/:sid/regenerate` | SHOULD |
| GET | `/api/v1/localize/demo` | public; the full promoted demo `Job` |
| GET | `/api/v1/localize/demo/audio/:which` | public; the demo job's audio, Range-aware |

**Amended 2026-09-10, Phase 4 — three departures from the table as first written.**
Audio is *streamed through the API with Range support*, not a signed GCS redirect:
V4 signing on Cloud Run needs the runtime service account granted
`iam.serviceAccountTokenCreator` on itself (missing by default, discovered on
deploy day), a signed URL is a bearer link that skips the owner check, and the
reasoning panel's per-segment play button seeks, which needs Range — which a
range-aware stream gives the GCS and local-disk backends identically. `/demo`
returns the *full Job* rather than an id, so `/jobs/:id` never needs a public
exception; the demo is a real API job flagged by `npm run localize:promote-demo`,
never a hand-seeded import. Ingest (normalize, length cap, silence check) runs
*inside* the POST, so an over-length clip is a 400 the uploader sees at once; the
`ingesting` status is therefore reserved and never observed.

Jobs run in-process after the POST returns (Cloud Run default request timeout
is 300 s; the pipeline takes ~60–90 s but must not sit on a request). `min-instances=1`
on the API service so the in-flight job is not killed by scale-to-zero.

### CLI stage scripts

`src/scripts/stage-analyze.ts fixtures/sample_60s.mp3 > outputs/analysis.json`,
then `stage-adapt.ts outputs/analysis.json`, `stage-critique.ts`, `stage-synthesize.ts`.
Each reads the previous stage's JSON, so any stage can be re-run alone.
`src/scripts/pipeline.ts` chains all four.

---

## c. Pedagogical signal taxonomy

Fixed enum, one label per segment, plus `none`. The analyze prompt carries these
exact definitions and examples.

| Label | Definition | Example (spoken) |
|---|---|---|
| `definition` | The speaker introduces a term and states what it means. | "A closure is a function that remembers the variables around it." |
| `key_term` | A term is named as vocabulary the learner must retain, often stressed or repeated, without a full definition here. | "Remember that word: *idempotent*. It'll come back." |
| `example` | A concrete instance, analogy, or walkthrough illustrating a concept already introduced. | "Think of it like a library card: the card lets you borrow, but it isn't the book." |
| `warning` | A pitfall, common mistake, or consequence the learner should avoid; tonal shift to cautionary. | "If you forget to await this, it will silently return a promise and your tests will pass for the wrong reason." |
| `emphasis_shift` | "This part matters" framing: the speaker signals importance through prosody or metadiscourse without it being a definition or warning. | "Okay, this next bit is the whole reason we're here." |
| `transition` | Structural navigation between topics; low information, keeps the learner oriented. | "So that's the setup. Now let's look at what happens at runtime." |
| `recap` | A restatement or summary of what was just taught. | "So, three things: create, sign, verify. That's the whole flow." |
| `none` | Filler or content with no distinct instructional role. | "Let me just move this window." |

`definition` beats `key_term` when both apply; `warning` beats `emphasis_shift`.
The prompt states these tie-breaks.

---

## d. The reasoning panel (per segment)

**Where it lives (amended 2026-10-01).** The product is a video library, not a
results dump. `/localize` is **My videos**: a grid of cards (poster frame from
ingest, topic, length, live status) with an *Upload video* dialog and an
owner-only delete (`DELETE /jobs/:id`, row and every GCS file under
`jobs/<id>/`). A card opens the **watch page**: one player with an
English | Hindi switch that keeps the playhead (stage 4 puts the Hindi on the
source timeline, so the same second is the same moment), an optional
side-by-side layout, a *Download Hindi* button (`?download=1`), and a one-line
score summary. Below it, two tabs: **Lesson** (a chapter list in the language
on screen) and **How the AI adapted it**, which holds everything in this
section unchanged: lesson map, scores, segments with this panel, the brief and
glossary, and the call log. The reasoning moved one click away, not out of
the product.

Selecting a segment in the side-by-side view opens a panel with, top to bottom:

1. **Signal header** — signal badge with confidence, register chip, pace chip,
   time range, and the one-line `signalEvidence`.
2. **Original** — English text with `emphasis` terms highlighted and each
   marker's `evidence` on hover.
3. **Adapted** — Hindi text with `emphasisTerms` highlighted; toggle to show
   `literalText` underneath so the reader sees what a naive translation would say.
4. **Why** — `rationale`, then one card per `AdaptationChoice`: kind icon,
   original → adapted, `why`.
5. **Check** — `backTranslation`, fidelity score as a 0–100 bar, signal/emphasis
   preserved ticks, `issues` list, and a "regenerated after critique" badge when
   the retry path ran.
6. **Voice** — the exact TTS settings applied (`speakingRate`, pause, voice,
   markup) and a play button for this segment only.
7. **Footer** — tokens and latency for the calls that produced this segment's
   stage outputs (from `Job.calls`), so the cost of the reasoning is visible.

The whole panel is data already in `Job`; no extra calls.

---

## e. Judging-criteria map

| Criterion | Weight | What earns the points |
|---|---|---|
| Technical merit & Gen AI implementation | 40% | Native audio understanding (not transcript-only) driving a three-stage structured chain (analyze → adapt → critique) with schema-enforced JSON; a bounded self-correction loop fed by the critique; prosody hints from stage 1 shaping Chirp 3 HD synthesis; token and latency telemetry per call; Zod as the single contract for model output, DB and API. Gen AI is the product, not a feature. |
| Problem alignment & impact | 25% | The signal taxonomy and fidelity score are direct measures of "does it still teach": a definition stays a definition, a warning still sounds like one, key terms survive as vocabulary. Hindi first targets the largest JAPAC learner population for English technical content. |
| Innovation & creativity | 25% | Pedagogical signal detection as a first-class artifact, with the model's prosody claims corroborated against measured ffmpeg energy and pause data rather than merely asserted; literal-vs-adapted with rationale per choice; a blind back-translation critique scoring fidelity *and* naturalness, shown to the user including the failures. Localization tools show output; this one shows judgment, and shows its working. |
| User experience & solution design | 10% | Upload → progress → side-by-side with synced audio and one-click reasoning panel. Pre-computed demo job for instant first impression. Designer owns visual polish and the deck. |

---

## f. Phased build plan (~52 h core, 40–60 h available)

Each phase ends with something runnable. MUST phases are the demo; SHOULD items
are done only after every MUST is green; NICE items are cut first.

Revised 2026-09-07 from ~46 h to ~52 h: acoustic evidence became core to Phase 1
(+3 h) and the brief/glossary/naturalness work became core to Phase 2 (+3 h).
The margin comes out of the SHOULD list, which is cut before any MUST slips.

### Phase 0 — Scaffold, env, one Gemini call (MUST, ~4 h)
- GCP project + billing (trial credits), AI Studio key, enable Cloud TTS API,
  GCS bucket. Wizard script in `deploy/gcp/setup.sh` walks the console steps.
- Add `GEMINI_API_KEY`, `GCS_BUCKET`, `TTS_VOICE`, `MAX_UPLOAD_BYTES`,
  `MAX_CLIP_SECONDS` to `src/config/index.ts`.
- `src/lib/gemini.ts`: client factory + `generateJson(schema, prompt, parts)`
  helper that sets `response_format`, parses, logs usage and latency.
- `src/scripts/smoke-gemini.ts`: sends the whole fixture, prints JSON.
- Drop `fixtures/sample_60s.mp3`; confirm ffmpeg on PATH and in the Dockerfile.
- Demoable: one structured Gemini response from real audio, in the terminal.

### Phase 1 — Analyze stage (MUST, ~11 h)
- `src/prompts/analyze.v1.md`, `Analysis` schema, `stage-analyze.ts`.
- **Acoustic evidence (core, not a fallback).** `src/lib/ffmpeg.ts` runs
  `silencedetect` (pause boundaries) and `astats` (per-window RMS energy) on
  every clip, and the analyze prompt receives that as text alongside the audio.
  This is what turns "the model says it heard stress on *idempotent*" into "the
  model's claim sits on top of a measured 400 ms pause and a 6 dB energy rise",
  which is the version that survives a judge pushing on the central claim.
  Measured pause boundaries also anchor segment `startSec`/`endSec`, which
  otherwise depend entirely on the model's own timestamping.
- Iterate the prompt on the fixture until segment boundaries and signal labels
  look right to a human. Save the good output as `fixtures/analysis.expected.json`.
- Demoable: `npm run stage:analyze` prints timestamped, labeled segments.

### Phase 2 — Adapt + critique with rationale (MUST, ~11 h)
- `brief.v1.md`, `adapt.v1.md`, `critique.v1.md`, schemas, the scripts, the
  one-shot retry. Stage 2a (brief + glossary) and sequential segment context are
  part of this phase, not extras — see section b.
- Demoable: `npm run pipeline -- --no-audio` prints Hindi + rationale + scores.

### Phase 3 — Synthesis with prosody (MUST, ~6 h)
- **Spike first (1 h):** send the same Hindi sentence to `hi-IN-Chirp3-HD-Kore`
  as plain text, with `speaking_rate`, with `[pause]` markup, and with SSML
  `<prosody>`/`<emphasis>`. Record what actually changes in `docs/research.md`.
- Per-segment synth + ffmpeg concat; `stage-synthesize.ts`.
- NICE: `gemini-3.1-flash-tts-preview` behind a flag for A/B in the video.
- Demoable: `outputs/output.mp3` plays, pauses land before warnings.

### Phase 4 — API module + web UI (MUST, ~12 h)
- `localize` module via the `new-module` skill: routes, service (pipeline
  orchestration, takes `Ctx`), repository, `localize_jobs` table + migration.
- Upload to GCS, async runner, polling endpoint, demo endpoint.
- `web/`: `/localize` page (upload + list), `/localize/[id]` (progress → side-by-side
  → panel). Reuse `web/src/lib/api/` client pattern; mirror DTOs in `schemas.ts`.
- Prod auth: single seeded user, `AUTH_REQUIRE_EMAIL_VERIFICATION=false`; relax
  the `MAIL_PROVIDER=console` boot refusal only when verification is off.
- Demoable: full flow in the browser on localhost.

### Phase 5 — Deploy, record, document (MUST, ~8 h)
- Cloud Run: `api` and `web` services, `min-instances=1` on `api`, Caddy-less:
  Next rewrites `/api/*` to the API service URL (see frontend contract note).
- Postgres: Cloud SQL smallest tier on credits → else `compose.prod.yml` on the
  US VPS → else Supabase. Decide on Phase 5 day 1 based on credit status.
- Pre-compute the fixture job in prod; `GET /demo` returns it.
- Record the 3-min video (designer edits), deck → PDF, README with diagram,
  public repo, submission form.

**Amended 2026-09-11, Phase 5 — as deployed** (`deploy/gcp/deploy.sh`; evidence in
`docs/research.md` § Cloud Run). Postgres is **Cloud SQL** (`db-f1-micro`, PG 17,
socket-only), region **asia-south1**. Three departures from the bullets above:
the API also runs `--no-cpu-throttling` and `--max-instances=1`, because Cloud
Run's default billing gives an instance CPU only while a request is in flight
and the job runs after its POST returns; `/api/*` is forwarded by
`web/src/proxy.ts` at runtime rather than by a `next.config.ts` rewrite, which is
build-time and would bake the API's URL into the image, with
`proxyClientMaxBodySize` raised above the upload cap because Next otherwise
truncates bodies over 10 MB without failing; and the shared demo account is an
ordinary user created through sign-up, not `create-admin`, since an admin can
list every user's email. Migrations and `promote-demo` run as the `localize-ops`
Cloud Run job against the same image and env.

### SHOULD (after all MUST)
- Per-segment regenerate button with an optional user note (~3 h).
- Segment-synced playhead highlighting in the side-by-side view (~2 h).
- Retry with backoff on 429; job-level cost cap (~1 h).

### NICE
- YouTube URL ingest via yt-dlp. Secondary language (Japanese). Vertex AI
  instead of AI Studio key. Gemini TTS A/B. ~~Speaker diarization for two-voice clips~~ (built 2026-10-07, stage 1).

---

## g. Risks and fallbacks

| Risk | Signal | Fallback |
|---|---|---|
| Gemini audio emphasis/prosody detection is weak or inconsistent | Stage 1 `emphasis` arrays empty or random on the fixture | **Already mitigated by design** — ffmpeg `astats`/`silencedetect` evidence is fed to the analyze prompt on every run from Phase 1 (moved out of this table into the build plan on 2026-09-07), so a weak model reading is corroborated or contradicted by measurement rather than trusted. If the arrays are still poor, escalate to `gemini-3.5-transcribe` for word-level timestamps and align the energy windows per word; ~4 h. |
| Hindi output is faithful but reads as stiff translationese | Low `naturalness` scores; the Hindi sounds like translated English rather than teaching | The brief + glossary + sequential context in stage 2a/2b exist for this, and stage 3 scores naturalness separately from fidelity so it cannot hide behind a good fidelity number. Failing segments go through the same one-shot retry. |
| Hindi runs 15–25% longer than the English, so `output.mp3` drifts out of sync with `source.mp3` in the side-by-side view | Output duration materially exceeds source on the fixture | Open — decide in Phase 2: accept and state it, fit `speakingRate` per segment to the source span, or give Adapt a per-segment length budget. Listed here so it is not discovered during Phase 4. |
| Chirp 3 HD ignores SSML `<prosody>`/`<emphasis>` (docs conflict) | Phase 3 spike shows no audible change | Use `speaking_rate` + `[pause]` markup only (confirmed for hi-IN), or switch voice to `hi-IN-Neural2-*` which supports full SSML. |
| Free-tier rate limit hit when a judge and the demo run together | 429 from Gemini | **Measured 2026-09-07: the free tier is 5 RPM, not the ≈10 previously assumed, and one job is 4–5 calls — so a single run nearly exhausts the minute and two concurrent runs cannot both pass.** Enabling billing (Tier 1) is therefore a submission requirement, not a precaution. Plus exponential backoff, and a pre-computed demo job that never calls Gemini. |
| Per-call latency eats the demo budget | Pipeline exceeds ~2 min on a 90 s clip | Measured: a *trivial* call costs ~16.5 s and 209 thought tokens at default thinking. Five sequential stages start at ~80 s before audio. Levers, in order: `thinking_level: "low"` on the mechanical stages (critique, adapt retry), batch segments per call rather than per segment, and run adapt and critique on the whole transcript in one call each. Decide with real numbers at the end of Phase 2. **Measured through the API 2026-09-10 (Phase 4): 215.8–237.9 s upload-to-done over three runs on the fixture; the slowest was analyze 84.4 s, brief + adapt 136.9 s for 9 segments, critique 8.0 s, synthesis 6.1 s (was ~16 s; now 4 concurrent).** Still double the budget, and ~93% of it is analyze + adapt, where the thinking is. The remaining levers (`low` on adapt, batched adapt) change the Hindi and must be judged on it, so they are not pulled blind; the demo meanwhile runs off the pre-computed `/demo` job. |
| Cloud Run request timeout / scale-to-zero kills a running job | Job stuck in `analyzing` | Async runner + polling already in design; `min-instances=1`; job marked `failed` on process start if older than 10 min. **Amended 2026-09-11: `min-instances` alone is not enough** — under request-based billing the instance has no CPU between requests, so the API deploys with `--no-cpu-throttling`, and `--max-instances=1` so no instance holding a job is scaled away. |
| Structured output rejects a "deeply nested" schema | 400 on `response_format` | Schemas are two levels deep by design; split Adapt into two calls if needed. |
| No native Hindi judge on the team | — | Critique back-translation and fidelity are shown in the UI as the quality evidence; ask a Hindi-speaking colleague to review the fixture output once before recording. |
| Postgres hosting undecided until credits confirmed | — | Three-way fallback in Phase 5; all three use the same `PG_*` env vars, so the app does not change. |
| Judge uploads something huge or non-speech | 413 / garbage analysis | Hard caps 100 MiB (in the signed URL) / 180 s; ffmpeg probe rejects silent files; per-user 5 jobs per hour rate limit. |
| Gemini model or API surface renamed mid-hackathon | SDK error | Model id and API version are single constants in `src/lib/gemini.ts`; `research.md` records the verified names and date. |

---

## h. Submission checklist

Verified against https://aibuildercup.com/Faqs.html and /themes.html on 2026-09-07.

- [ ] Team registered with **2–4 members** (builder + designer); solo entries are not eligible.
- [ ] Theme selected: **Media, Content & Digital Experiences** (there is no Education theme).
- [ ] All code written after 7 Sept 2026 (fresh-project rule); boilerplate is a starting template, state that in the README.
- [x] Only Google models used for generation: `gemini-3.8-flash`, Gemini TTS (`gemini-3.1-flash-tts-preview`), Cloud TTS Chirp 3 HD. No other AI APIs in the repo. *(Verified 2026-09-11: no non-Google AI package in either package.json or source.)*
- [x] Deployed on Google Cloud: API and web on **Cloud Run**, files on GCS. Public URL works signed-out for the demo job. *(Verified 2026-09-11: `check-demo.ts` against https://localize-web-13108575259.asia-south1.run.app, all checks passed.)*
- [ ] Public GitHub repository; `.env.*` and service-account JSON never committed; README has setup, architecture diagram, and the doc citations.
- [ ] Demo video **under 3 minutes**, shows a real run end-to-end plus the reasoning panel.
- [ ] Deck exported as **PDF** (problem, differentiator, pipeline, judging map, what's next).
- [ ] All code, comments, docs, UI copy in English.
- [ ] Submission form completed before **4 Oct 2026** (Hack2skill platform); keep a screenshot of the confirmation.
- [x] Billing enabled on the GCP project so rate limits do not bite during evaluation (5 Oct – 6 Nov). *(Verified 2026-09-11: `billingEnabled: true`.)*
- [ ] Credits question emailed to support+aibuildercup@hack2skill.com (FAQ does not mention credits).
