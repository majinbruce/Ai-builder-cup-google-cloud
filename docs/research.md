# Research notes — verified 2026-09-07

Facts checked against Google's own docs on the date above. When code disagrees with
this file, the API changed: tell the user, then update this file.

## Gemini (AI Studio, `@google/genai` 2.21.0)

| Item | Verified value | Source |
|---|---|---|
| Text + audio model | `gemini-3.8-flash`, stable Sep 2026. Inputs: text, image, video, audio, PDF. Output: text. 1,048,576 in / 65,536 out. Structured outputs, thinking, caching. Free-tier eligible. | https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash |
| API surface | **Interactions API** (`client.interactions.create`) is GA since June 2026 and recommended for new projects. `generateContent` is "legacy" but supported. SDK ≥ 2.3.0. | https://ai.google.dev/gemini-api/docs/interactions-overview |
| Structured output | `response_format: { type: "text", mime_type: "application/json", schema }`. Read with `interaction.output_text`. Supports enum, nested objects, arrays, anyOf, min/max, required. "Very large or deeply nested schemas may be rejected." Docs pair it with `z.fromJSONSchema`; we go the other way with `z.toJSONSchema(zodSchema)`. | https://ai.google.dev/gemini-api/docs/structured-output |
| Audio input | 13 formats incl. mp3/wav/m4a/webm. 32 tokens per second (~1,920/min). Inline base64 when total request ≤ 20 MB, else Files API (`client.files.upload`). Audio is downsampled to 16 kbps mono. Prompt with `MM:SS` for timestamps. Docs show emotion labelling; **prosody/emphasis detection is not documented** → see risk in SPEC §g. | https://ai.google.dev/gemini-api/docs/audio |
| Word timestamps fallback | `gemini-3.5-transcribe` (GA): speech-to-text with word-level timestamps, diarization, 85+ languages. | https://ai.google.dev/gemini-api/docs/models |
| Gemini TTS | `gemini-3.1-flash-tts-preview`, `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts` — **all Preview**. Hindi (`hi`) listed. Style via natural-language prompt and audio tags (`[whispers]`, `[excited]`). Output PCM 16-bit 24 kHz base64 in `interaction.output_audio.data`. 32k-token session limit. NICE only. | https://ai.google.dev/gemini-api/docs/speech-generation |
| Pricing | 3.8 Flash paid: $0.75 in / $3.75 out per 1M (promo to 31 Dec 2026). 3.1 Flash TTS: $1 text in / $20 audio out per 1M. Free tier: free. | https://ai.google.dev/gemini-api/docs/pricing |
| Rate limits | Not published per model; read your tier at https://aistudio.google.com/rate-limit. Third-party reports for free tier: ~10 RPM, 1,500 RPD on Flash. Tier 1 = enable billing in AI Studio. One job ≈ 4–5 Gemini calls. | https://ai.google.dev/gemini-api/docs/rate-limits |

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

Token usage field on the interaction object is not shown in the docs excerpts;
Phase 0 smoke test must print the full response once to find it.

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
