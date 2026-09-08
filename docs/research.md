# Research notes — verified 2026-09-07

Facts checked against Google's own docs on the date above. When code disagrees with
this file, the API changed: tell the user, then update this file.

## Gemini (AI Studio, `@google/genai` 2.21.0)

| Item | Verified value | Source |
|---|---|---|
| Text + audio model | `gemini-3.8-flash`, stable Sep 2026. Inputs: text, image, video, audio, PDF. Output: text. 1,048,576 in / 65,536 out. Structured outputs, thinking, caching. Free-tier eligible. | https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash |
| API surface | **Interactions API** (`client.interactions.create`) is GA since June 2026 and recommended for new projects. `generateContent` is "legacy" but supported. SDK ≥ 2.3.0. | https://ai.google.dev/gemini-api/docs/interactions-overview |
| Structured output | `response_format: { type: "text", mime_type: "application/json", schema }`. Read with `interaction.output_text`. Supports enum, nested objects, arrays, anyOf, min/max, required. "Very large or deeply nested schemas may be rejected." Docs pair it with `z.fromJSONSchema`; we go the other way with `z.toJSONSchema(zodSchema)`. | https://ai.google.dev/gemini-api/docs/structured-output |
| Audio input | 13 formats incl. mp3/wav/m4a/webm. Docs say 32 tokens per second (~1,920/min); **measured 2026-09-07 on a 63.1 s 16 kHz mono mp3: 1,576 audio tokens = ~25/sec**, so budget from the doc figure and expect to come in under it. Usage reports the split explicitly in `input_tokens_by_modality`, which is how a run proves the audio was actually ingested rather than the model answering from the prompt alone. Inline base64 when total request ≤ 20 MB, else Files API (`client.files.upload`). Audio is downsampled to 16 kbps mono. Prompt with `MM:SS` for timestamps. Docs show emotion labelling; **prosody/emphasis detection is not documented** → see risk in SPEC §g. | https://ai.google.dev/gemini-api/docs/audio |
| Word timestamps fallback | `gemini-3.5-transcribe` (GA): speech-to-text with word-level timestamps, diarization, 85+ languages. | https://ai.google.dev/gemini-api/docs/models |
| Gemini TTS | `gemini-3.1-flash-tts-preview`, `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts` — **all Preview**. Hindi (`hi`) listed. Style via natural-language prompt and audio tags (`[whispers]`, `[excited]`). Output PCM 16-bit 24 kHz base64 in `interaction.output_audio.data`. 32k-token session limit. NICE only. | https://ai.google.dev/gemini-api/docs/speech-generation |
| Pricing | 3.8 Flash paid: $0.75 in / $3.75 out per 1M (promo to 31 Dec 2026). 3.1 Flash TTS: $1 text in / $20 audio out per 1M. Free tier: free. | https://ai.google.dev/gemini-api/docs/pricing |
| Rate limits | **MEASURED 2026-09-07, twice, and the second measurement is the one that bites. First: `limit: 5` on `generativelanguage.googleapis.com/generate_content_free_tier_requests` — a per-minute cap. Then, during Phase 1, the SAME metric started returning `limit: 20` and kept returning it after 70 s and again after 7 minutes of complete idleness.** A per-minute bucket resets in 60 s, so the binding constraint is not RPM: it is a longer-window free-tier request cap (a daily RPD cap is the obvious reading; the 429 does not name the window, so this file does not claim to know which). Consequence: **the free tier allows roughly twenty `gemini-3.8-flash` requests per day across the whole project**, and one pipeline run is 4–5 of them. That is four runs a day — not enough to iterate a prompt, and not enough to survive a judge and a demo on the same day. Enabling billing (Tier 1) is a hard prerequisite for Phase 1 onward, not a submission-week checklist item. Verbatim: `Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash`. | measured; https://ai.google.dev/gemini-api/docs/rate-limits |
| Billing / prepay | **MEASURED 2026-09-07 (third observation, and it supersedes the reading above).** After the free-tier 429s, the same key began returning a different 429 with no quota metric at all: `Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.` Reproduced twice, back to back. So the project is on **prepaid** billing with a zero balance, not on the free tier — which means the earlier `limit: 20` free-tier message was the state *before* billing was attached, and the current blocker is a funding one, not a rate one. Prepay does not auto-recharge: the balance is topped up in AI Studio (https://ai.studio/projects), and until it is, **every** Gemini call in this repo fails, including the pre-computed demo job. Check the balance before a demo the way you would check a deploy. **RESOLVED 2026-09-08: the balance was topped up and calls succeed again** — the diagnosis held exactly, and nothing in the code had to change. Cost confirms the top-up is not a recurring worry: a full analyze call on the 63 s fixture is ~4.0k in + ~2.2k out + up to ~20k thinking ≈ **$0.09**, so five Phase-1 iterations cost under fifty cents. Budget by thinking tokens, not by request count. | measured; https://ai.google.dev/gemini-api/docs/billing#prepay |
| Thinking | `generation_config.thinking_level` accepts only `low` \| `medium` \| `high` on `gemini-3.8-flash` — `"minimal"` is a 400 (`'minimal' is not a supported thinking level for this model`), despite the SDK's union type listing it. Default thinking is not free: a trivial text prompt spent **209 thought tokens and 16.5 s** wall clock. Budget this against the "60–90 s clip in under 2 min" demo target — 5 sequential calls of that shape is already ~80 s before any audio is processed. `thinking_level: "low"` is the lever if Phase 4 runs slow. **MEASURED 2026-09-08 on the real Phase 1 analyze stage, and the latency risk in SPEC §g is now confirmed rather than theoretical: one analyze call takes 63-70 s and spends 18,000-20,600 thought tokens against only ~2,200 output tokens.** Thinking is ~90% of the generated tokens and the dominant cost and latency term. It is also wildly variable on identical input: four runs of the same fixture spent 17,887 / 18,668 / 20,617 and — once — **1,864** thought tokens, that last one finishing in 15.7 s instead of 70 s. So a single stage can consume the whole "60-90 s clip in under 2 min" demo budget on its own, and the pipeline cannot be five sequential calls of this shape. Decide `thinking_level` with numbers at the end of Phase 2, as planned; the lever is now known to be necessary, not optional. Note the 15.7 s run also produced the *worst* segmentation of the four, so buying latency with `low` has to be judged on output quality, not just on the clock. | measured 2026-09-07, extended 2026-09-08 |

Verified JS shapes (from the docs, verbatim):

```js
import { GoogleGenAI } from "@google/genai";
const client = new GoogleGenAI({});               // reads GEMINI_API_KEY
const interaction = await client.interactions.create({
  model: "gemini-3.8-flash",
  input: [
    { type: "text", text: prompt },
    { type: "audio", data: base64, mime_type: "audio/mp3" },   // or { uri, mime_type } via Files API
  ],
  response_format: { type: "text", mime_type: "application/json", schema: jsonSchema },
});
const parsed = zodSchema.parse(JSON.parse(interaction.output_text));
```

**Verified against the SDK typings on 2026-09-07 (Phase 0), not the docs:**

- `response_format` is a **top-level** field on `CreateModelInteraction`, not
  nested inside `generation_config` (`genai.d.ts` L2803). `generation_config`
  has no such field. The snippet above is correct as written.
- `interactions.create` params are flat: `{ model, input, response_format }`
  (`CreateModelInteractionParamsNonStreaming`, L2852). No `body` wrapper.
- `input` accepts `Content_2 | Content_2[] | string`, where `Content_2` is a
  union of `{ type: "text", text }` and `{ type: "audio", data | uri,
  mime_type, sample_rate?, channels? }` (L8909, L795).
- **Token usage** — the open question is answered. It is `interaction.usage`,
  of type `Usage` (L16882): `total_input_tokens`, `total_output_tokens`,
  `total_thought_tokens`, `total_cached_tokens`, plus per-modality breakdowns
  (`input_tokens_by_modality`, …). Read by `src/lib/gemini.ts` into `ModelCall`.
  **Measured 2026-09-07: `total_output_tokens` EXCLUDES thinking.** On the smoke
  call, `1925 in + 151 out + 208 thought = 2284 total`. So output and thought are
  disjoint and both are billed at the output rate — cost is
  `(out + thought) × $3.75/1M`, and reading `total_output_tokens` alone
  under-reports a thinking-heavy stage by more than half.
- `z.toJSONSchema()` (Zod 4) emits a `$schema` meta key that Gemini's OpenAPI
  subset has no use for; `src/lib/gemini.ts` strips it before sending.
- **`$ref`/`$defs` are not a problem.** Gemini's schema subset has no `$ref`, so
  a Zod schema that extracted shared sub-objects into `$defs` would 400. Checked
  2026-09-07 against the full `Analysis` shape from SPEC §b plus a deliberately
  reused sub-object: Zod 4 **inlines** repeated schemas rather than emitting
  `$defs`, so the SPEC schemas convert cleanly. Re-check if Zod is upgraded.

## ffmpeg acoustic measurement (Phase 1, measured on this machine)

ffmpeg 6.1.1-3ubuntu5. Measured on `fixtures/sample_60s.mp3` (63.1 s, 16 kHz mono,
mean -16.4 dBFS after the `loudnorm` pass described in `fixtures/README.md`).

| Item | Verified value |
|---|---|
| Duration | `ffprobe -show_entries format=duration` reads it from the container; no decode needed. |
| Mean level | `-af volumedetect` prints `mean_volume: -16.4 dB` on **stderr**. |
| Silence detection | **A fixed threshold does not work.** On this clip `-33 dB` finds **0** pauses (as do -35 and -40), while `-22.4 dB` (mean - 6) finds **9** and `-18 dB` finds 26, many of them mid-word. The threshold has to be derived from the clip's own mean. `src/modules/localize/acoustics.ts` walks mean - {4, 6, 8, 12, 16} dB and stops at the first density between 6 and 15 pauses per minute; the fixture selects mean - 6. |
| Energy series | `asetnsamples=n=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-` emits one value per window on **stdout** (not stderr, unlike every other filter here). 0.5 s windows over 63.1 s give **127 windows**, 5 of them at or above median + 3 dB. |
| Digital silence | astats reports `-inf`, which is not a usable number; floored at -120 dBFS in `parseRmsWindows`. |

### Corroboration, measured against real model output (2026-09-08, Phase 1)

Five real analyze runs on `fixtures/sample_60s.mp3`. Numbers to quote, and the
two reporting bugs the first live run exposed that no synthetic test could.

| Item | Verified value |
|---|---|
| Emphasis corroboration | Stable across runs: **16/19, 16/19, 13/15 supported (84-87%)**. But the headline is not the number to cite — see below. |
| Energy-backed corroboration | **53-55% in every run.** This is the honest figure. The remaining support comes from a pause merely closing the span, and `analyze.v1.md` *tells* the model to cut at the measured pauses, so that branch partly rewards instruction-following rather than hearing. `corroborate.ts` now reports `supportedByEnergy` and `supportedByPauseOnly` separately for exactly this reason. |
| Boundary alignment | Counting every segment's `startSec` and `endSec` double-counted each interior cut and added the clip's own 0.0 and duration, which can never sit near a mid-clip pause: a real 4-of-8 was reported as "8/18 (44%)". Now counts distinct **interior** boundaries only. |
| **Do not optimize boundary alignment** | The run that scored best on it (83% aligned, 100% emphasis support, 15.7 s) was the **worst** output of the five: it obeyed "cut at the pauses" so literally that it cut mid-clause — splitting a list from its introduction, and splitting one definition so its subject sat in one segment and its predicate in the next. Metrics up, stage-1 purpose destroyed. The prompt now states that the instructional move wins over the pause, after which alignment fell back to 44% and the segmentation was correct. Treat a rising alignment number as a warning sign, not progress. |
| Label stability | 8/9 signal labels identical across two independent runs, boundaries within 0.8 s. The disagreement was `example` vs `warning` on "Galileo... was wrong" — fixed in the prompt with a tie-break: `warning` is about the *learner's* conduct, so a historical figure's failed attempt is an `example`. |
| Audio is genuinely ingested | `input_tokens_by_modality` reports the audio split on every analyze call, as in Phase 0. |

## Cloud Text-to-Speech

| Item | Verified value | Source |
|---|---|---|
| Voice family | Chirp 3 HD, GA. Name pattern `<locale>-Chirp3-HD-<Voice>`, e.g. `hi-IN-Chirp3-HD-Kore`. 30 voice names (Aoede, Charon, Kore, Puck, Zephyr, …). `hi-IN` supported. | https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd |
| Pace | `speaking_rate` 0.25–2.0. | same |
| Pauses | `markup` input with `[pause short]`, `[pause long]`, `[pause]`; available for `hi-IN`. | same |
| Custom pronunciation | IPA / X-SAMPA via `custom_pronunciations`; available for `hi-IN`. | same |
| **SSML — CONFLICT** | Release note 2025-10-17: Chirp 3 HD SSML supports only `<phoneme>`, `<p>`, `<s>`, `<sub>`, `<say-as>`. Current Chirp 3 HD page lists `<prosody>`, `<break>`, `<voice>`, `<audio>` too. Voice-list page says Chirp 3 HD "doesn't support SSML input". **Resolve empirically in Phase 3 spike.** | https://docs.cloud.google.com/text-to-speech/docs/release-notes, https://docs.cloud.google.com/text-to-speech/docs/list-voices-and-types |
| Full-SSML fallback | Neural2 / WaveNet voices support `<prosody rate|pitch|volume>`, `<emphasis level>`, `<break>`. Hindi Neural2 voices exist under `hi-IN`. | https://docs.cloud.google.com/text-to-speech/docs/ssml |
| Node SDK | `@google-cloud/text-to-speech` 7.0.0. Auth via ADC / service account. | npm |

## Cloud Run

- Request timeout default 300 s, max 3600 s. Jobs run async; never block a request on the pipeline. https://docs.cloud.google.com/run/docs/configuring/request-timeout
- Cannot host Postgres (no persistent disk, scale-to-zero). DB options in priority order: Cloud SQL on credits → user's US VPS with `compose.prod.yml` → Supabase.

## ADK

`@google/adk` 2.0 GA for TypeScript, Node ≥ 24.13. Not used: the pipeline is a fixed
sequence with typed hand-offs, which is a function chain; ADK adds an agent runtime
without adding a capability we need. Revisit only if per-segment regeneration grows
into a real tool-using loop. https://adk.dev/get-started/typescript/

## Hackathon rules

- Team 2–4, professionals only, JAPAC-based, fresh project. No solo entries.
- Six themes; no Education theme. Ours: **Media, Content & Digital Experiences**.
- Deliverables: deployed link (Cloud Run/GCP/Firebase), video < 3 min, public GitHub repo, deck as PDF.
- Judging: Technical 40 / Alignment 25 / Innovation 25 / UX 10.
- Build window 7 Sept – 3 Oct, deadline 4 Oct 2026. Evaluation 5 Oct – 6 Nov.
- Credits: FAQ silent; aggregator posts claim credits are provided. Ask support+aibuildercup@hack2skill.com. New GCP accounts get the standard $300/90-day trial regardless.
- https://aibuildercup.com/Faqs.html, https://aibuildercup.com/themes.html

## Local tooling (this machine)

Node v24.14.0. `ffmpeg`, `gcloud`, `firebase` CLIs: not installed yet (Phase 0).
