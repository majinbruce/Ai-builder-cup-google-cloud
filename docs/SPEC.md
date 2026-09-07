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

Input: multipart upload (`audio/*`, `video/mp4`, ≤ 25 MB, ≤ 180 s) or, NICE, a
YouTube URL. ffmpeg normalizes to 16 kHz mono MP3 (Gemini downsamples to 16 kbps
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
export const AnalyzedSegment = z.object({
  id: z.string(),                         // "s01"
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
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
  segments: z.array(AnalyzedSegment).min(1),
});
```

### Stage 2 — Adapt (Gemini, text in, JSON out)

Input: `Analysis` + target language (`hi`) + `adapt.v1.md`. The prompt makes the
model translate *intent*, keep `keyTerms` in English where Hindi technical
speech does (Hinglish is the norm in Indian tech education and the prompt says
so), reproduce every `emphasis` term with a marker, and explain each non-literal
decision. Every segment must come back; ids must match.

```ts
export const AdaptationChoice = z.object({
  kind: ChoiceKind,
  original: z.string(),
  adapted: z.string(),
  why: z.string(),                        // one or two sentences, learner-facing
});
export const AdaptedSegment = z.object({
  id: z.string(),
  targetText: z.string(),                 // Hindi (Devanagari), Hinglish terms allowed
  literalText: z.string(),                // what a literal translation would say
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
  segments: z.array(AdaptedSegment).min(1),
});
```

### Stage 3 — Critique (Gemini, separate call, JSON out)

Input: original `AnalyzedSegment.text` + `AdaptedSegment.targetText` pairs plus
the signal labels, with `critique.v1.md`. The model back-translates each Hindi
segment *without seeing the English rationale*, then scores instructional
fidelity. Segments with `fidelity < 70` or `signalPreserved === false` are sent
back to Adapt **once** with the critique attached; the second result is kept
regardless (bounded loop, no runaway cost).

```ts
export const SegmentCritique = z.object({
  id: z.string(),
  backTranslation: z.string(),
  fidelity: z.number().int().min(0).max(100),
  signalPreserved: z.boolean(),
  emphasisPreserved: z.boolean(),
  issues: z.array(z.string()),
  suggestion: z.string().optional(),
});
export const Critique = z.object({
  overallFidelity: z.number().int().min(0).max(100),
  segments: z.array(SegmentCritique).min(1),
});
```

### Stage 4 — Synthesize (Cloud Text-to-Speech, Chirp 3 HD, `hi-IN`)

Per segment, one `synthesizeSpeech` call with `speaking_rate = ttsHints.speakingRate`,
`[pause short|long]` markup prepended when `pauseBefore != none`, and emphasis
via SSML `<prosody>`/`<emphasis>` **if** the Phase 3 spike confirms Chirp 3 HD
honors them; otherwise emphasis is realized through a slightly slower rate on
the emphasized clause and a short pause after it (both confirmed supported).
Fallback voice with full SSML: `hi-IN-Neural2-*`. Segments are concatenated with
ffmpeg and stored as `jobs/<jobId>/output.mp3`.

```ts
export const SynthesizedSegment = z.object({
  id: z.string(),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  voice: z.string(),
  speakingRate: z.number(),
  markupUsed: z.string(),                 // exact text/SSML sent, for the audit panel
});
export const Synthesis = z.object({
  audioUri: z.string(),
  durationSec: z.number().positive(),
  segments: z.array(SynthesizedSegment),
});
```

### Job envelope (Postgres row + API DTO)

```ts
export const ModelCall = z.object({
  stage: z.enum(["analyze", "adapt", "critique", "adapt_retry", "synthesize"]),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
});
export const Job = z.object({
  id: z.uuid(),
  status: JobStatus,
  targetLanguage: z.string(),
  sourceUri: z.string().nullable(),
  error: z.string().nullable(),
  analysis: Analysis.nullable(),
  adaptation: Adaptation.nullable(),
  critique: Critique.nullable(),
  synthesis: Synthesis.nullable(),
  calls: z.array(ModelCall),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
```

Table `localize_jobs`: `id`, `user_id`, `status`, `target_language`,
`source_uri`, `error`, `analysis jsonb`, `adaptation jsonb`, `critique jsonb`,
`synthesis jsonb`, `calls jsonb`, timestamps. Stage outputs are opaque JSON
validated by the Zod schemas above at write and read.

### API surface (`src/modules/localize/`)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/localize/jobs` | multipart; returns `Job` with `status: queued` |
| GET | `/api/v1/localize/jobs/:id` | poll; full `Job` |
| GET | `/api/v1/localize/jobs/:id/audio/:which` | `source` or `output`, signed GCS redirect |
| POST | `/api/v1/localize/jobs/:id/segments/:sid/regenerate` | SHOULD |
| GET | `/api/v1/localize/demo` | returns the pre-computed fixture job id |

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
| Innovation & creativity | 25% | Pedagogical signal detection as a first-class artifact; literal-vs-adapted with rationale per choice; independent back-translation critique visible to the user. Localization tools show output; this one shows judgment. |
| User experience & solution design | 10% | Upload → progress → side-by-side with synced audio and one-click reasoning panel. Pre-computed demo job for instant first impression. Designer owns visual polish and the deck. |

---

## f. Phased build plan (~46 h core, 40–60 h available)

Each phase ends with something runnable. MUST phases are the demo; SHOULD items
are done only after every MUST is green; NICE items are cut first.

### Phase 0 — Scaffold, env, one Gemini call (MUST, ~4 h)
- GCP project + billing (trial credits), AI Studio key, enable Cloud TTS API,
  GCS bucket. Wizard script in `deploy/gcp/setup.sh` walks the console steps.
- Add `GEMINI_API_KEY`, `GCS_BUCKET`, `TTS_VOICE`, `MAX_UPLOAD_BYTES`,
  `MAX_CLIP_SECONDS` to `src/config/index.ts`.
- `src/lib/gemini.ts`: client factory + `generateJson(schema, prompt, parts)`
  helper that sets `response_format`, parses, logs usage and latency.
- `src/scripts/smoke-gemini.ts`: sends 5 s of the fixture, prints JSON.
- Drop `fixtures/sample_60s.mp3`; confirm ffmpeg on PATH and in the Dockerfile.
- Demoable: one structured Gemini response from real audio, in the terminal.

### Phase 1 — Analyze stage (MUST, ~8 h)
- `src/prompts/analyze.v1.md`, `Analysis` schema, `stage-analyze.ts`.
- Iterate the prompt on the fixture until segment boundaries and signal labels
  look right to a human. Save the good output as `fixtures/analysis.expected.json`.
- Demoable: `npm run stage:analyze` prints timestamped, labeled segments.

### Phase 2 — Adapt + critique with rationale (MUST, ~8 h)
- `adapt.v1.md`, `critique.v1.md`, schemas, both scripts, the one-shot retry.
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

### SHOULD (after all MUST)
- Per-segment regenerate button with an optional user note (~3 h).
- Segment-synced playhead highlighting in the side-by-side view (~2 h).
- Retry with backoff on 429; job-level cost cap (~1 h).

### NICE
- YouTube URL ingest via yt-dlp. Secondary language (Japanese). Vertex AI
  instead of AI Studio key. Gemini TTS A/B. Speaker diarization for two-voice clips.

---

## g. Risks and fallbacks

| Risk | Signal | Fallback |
|---|---|---|
| Gemini audio emphasis/prosody detection is weak or inconsistent | Stage 1 `emphasis` arrays empty or random on the fixture | Run `gemini-3.5-transcribe` for word-level timestamps, compute per-word RMS energy and local pauses with ffmpeg `astats`/`silencedetect`, feed both to the analyze prompt as text hints alongside the audio. Documented in `research.md`; ~4 h. |
| Chirp 3 HD ignores SSML `<prosody>`/`<emphasis>` (docs conflict) | Phase 3 spike shows no audible change | Use `speaking_rate` + `[pause]` markup only (confirmed for hi-IN), or switch voice to `hi-IN-Neural2-*` which supports full SSML. |
| Free-tier rate limit (≈10 RPM) hit when a judge and the demo run together | 429 from Gemini | Enable billing before submission (Tier 1); exponential backoff; pre-computed demo job never calls Gemini. |
| Cloud Run request timeout / scale-to-zero kills a running job | Job stuck in `analyzing` | Async runner + polling already in design; `min-instances=1`; job marked `failed` on process start if older than 10 min. |
| Structured output rejects a "deeply nested" schema | 400 on `response_format` | Schemas are two levels deep by design; split Adapt into two calls if needed. |
| No native Hindi judge on the team | — | Critique back-translation and fidelity are shown in the UI as the quality evidence; ask a Hindi-speaking colleague to review the fixture output once before recording. |
| Postgres hosting undecided until credits confirmed | — | Three-way fallback in Phase 5; all three use the same `PG_*` env vars, so the app does not change. |
| Judge uploads something huge or non-speech | 413 / garbage analysis | Hard caps 25 MB / 180 s at the route; ffmpeg probe rejects silent files; per-user 5 jobs per hour rate limit. |
| Gemini model or API surface renamed mid-hackathon | SDK error | Model id and API version are single constants in `src/lib/gemini.ts`; `research.md` records the verified names and date. |

---

## h. Submission checklist

Verified against https://aibuildercup.com/Faqs.html and /themes.html on 2026-09-07.

- [ ] Team registered with **2–4 members** (builder + designer); solo entries are not eligible.
- [ ] Theme selected: **Media, Content & Digital Experiences** (there is no Education theme).
- [ ] All code written after 7 Sept 2026 (fresh-project rule); boilerplate is a starting template, state that in the README.
- [ ] Only Google models used for generation: `gemini-3.8-flash`, Cloud TTS Chirp 3 HD. No other AI APIs in the repo.
- [ ] Deployed on Google Cloud: API and web on **Cloud Run**, files on GCS. Public URL works signed-out for the demo job.
- [ ] Public GitHub repository; `.env.*` and service-account JSON never committed; README has setup, architecture diagram, and the doc citations.
- [ ] Demo video **under 3 minutes**, shows a real run end-to-end plus the reasoning panel.
- [ ] Deck exported as **PDF** (problem, differentiator, pipeline, judging map, what's next).
- [ ] All code, comments, docs, UI copy in English.
- [ ] Submission form completed before **4 Oct 2026** (Hack2skill platform); keep a screenshot of the confirmation.
- [ ] Billing enabled on the GCP project so rate limits do not bite during evaluation (5 Oct – 6 Nov).
- [ ] Credits question emailed to support+aibuildercup@hack2skill.com (FAQ does not mention credits).
