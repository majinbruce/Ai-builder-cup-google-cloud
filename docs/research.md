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
| Rate limits | **MEASURED 2026-09-07, not third-party: the free tier is 5 RPM on `gemini-3.8-flash`, not the ~10 RPM previously recorded here.** Verbatim from the 429: `Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-3.8-flash`. One job is 4–5 Gemini calls, so **a single job very nearly exhausts the free per-minute quota** and two concurrent runs cannot both succeed. Billing (Tier 1) is not a nice-to-have before submission, it is a requirement. | measured; https://ai.google.dev/gemini-api/docs/rate-limits |
| Thinking | `generation_config.thinking_level` accepts only `low` \| `medium` \| `high` on `gemini-3.8-flash` — `"minimal"` is a 400 (`'minimal' is not a supported thinking level for this model`), despite the SDK's union type listing it. Default thinking is not free: a trivial text prompt spent **209 thought tokens and 16.5 s** wall clock. Budget this against the "60–90 s clip in under 2 min" demo target — 5 sequential calls of that shape is already ~80 s before any audio is processed. `thinking_level: "low"` is the lever if Phase 4 runs slow. | measured 2026-09-07 |

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
- `z.toJSONSchema()` (Zod 4) emits a `$schema` meta key that Gemini's OpenAPI
  subset has no use for; `src/lib/gemini.ts` strips it before sending.

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
