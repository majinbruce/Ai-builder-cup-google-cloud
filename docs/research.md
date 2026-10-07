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
| Gemini TTS | `gemini-3.1-flash-tts-preview`, `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts` — **all Preview**. Hindi (`hi`) listed. Style via natural-language prompt and audio tags (`[whispers]`, `[excited]`). Output PCM 16-bit 24 kHz base64 in `interaction.output_audio.data`. 32k-token session limit. NICE only. **Superseded 2026-10-07: the pipeline speaks with `gemini-3.8-flash-tts` — § Gemini 3.8 TTS.** **The docs changed by 2026-10-06 — READ, NOT MEASURED (no call was spent on it):** the same page and the models page now list **`gemini-3.8-flash-tts`** and **`gemini-3.8-flash-lite-tts`** as *Stable* ("Latest update: September 2026", 8,192 in / 16,384 out, Hindi listed), with `gemini-3.1-flash-tts-preview` — the model this pipeline speaks with — still Preview and named as the one they replace. Their request shape differs from ours: the text goes in as `input: [{type: "user_input", content: [{type: "text", text, annotations: [{type: "speech_metadata", style}]}]}]` with `response_format: {type: "audio"}`; the installed SDK (2.21.0) has no `speech_metadata` in its typings, so it needs an upgrade. Pace is a turn-level `style` ("speaking slowly"/"speaking rapidly") plus inline `<short pause>` / `<long pause>`; there is still no rate or duration parameter. And the page now says of prompts like ours: "Long-form \"Audio Profile\" paragraphs and multi-bullet \"Director's Notes\" carried over from earlier models are the most common cause of voice drift." Whether any of this holds on `hi` is unmeasured; see § Dub audit. | https://ai.google.dev/gemini-api/docs/speech-generation · https://ai.google.dev/gemini-api/docs/models |
| Pricing | 3.8 Flash paid: $0.75 in / $3.75 out per 1M (promo to 31 Dec 2026). 3.1 Flash TTS: $1 text in / $20 audio out per 1M. Free tier: free. | https://ai.google.dev/gemini-api/docs/pricing |
| Rate limits | **MEASURED 2026-09-07, twice, and the second measurement is the one that bites. First: `limit: 5` on `generativelanguage.googleapis.com/generate_content_free_tier_requests` — a per-minute cap. Then, during Phase 1, the SAME metric started returning `limit: 20` and kept returning it after 70 s and again after 7 minutes of complete idleness.** A per-minute bucket resets in 60 s, so the binding constraint is not RPM: it is a longer-window free-tier request cap (a daily RPD cap is the obvious reading; the 429 does not name the window, so this file does not claim to know which). Consequence: **the free tier allows roughly twenty `gemini-3.8-flash` requests per day across the whole project**, and one pipeline run is 4–5 of them. That is four runs a day — not enough to iterate a prompt, and not enough to survive a judge and a demo on the same day. Enabling billing (Tier 1) is a hard prerequisite for Phase 1 onward, not a submission-week checklist item. Verbatim: `Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash`. | measured; https://ai.google.dev/gemini-api/docs/rate-limits |
| Billing / prepay | **MEASURED 2026-09-07 (third observation, and it supersedes the reading above).** After the free-tier 429s, the same key began returning a different 429 with no quota metric at all: `Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.` Reproduced twice, back to back. So the project is on **prepaid** billing with a zero balance, not on the free tier — which means the earlier `limit: 20` free-tier message was the state *before* billing was attached, and the current blocker is a funding one, not a rate one. Prepay does not auto-recharge: the balance is topped up in AI Studio (https://ai.studio/projects), and until it is, **every** Gemini call in this repo fails, including the pre-computed demo job. Check the balance before a demo the way you would check a deploy. **RESOLVED 2026-09-08: the balance was topped up and calls succeed again** — the diagnosis held exactly, and nothing in the code had to change. Cost confirms the top-up is not a recurring worry: a full analyze call on the 63 s fixture is ~4.0k in + ~2.2k out + up to ~20k thinking ≈ **$0.09**, so five Phase-1 iterations cost under fifty cents. Budget by thinking tokens, not by request count. | measured; https://ai.google.dev/gemini-api/docs/billing#prepay |
| Thinking | `generation_config.thinking_level` accepts only `low` \| `medium` \| `high` on `gemini-3.8-flash` — `"minimal"` is a 400 (`'minimal' is not a supported thinking level for this model`), despite the SDK's union type listing it. Default thinking is not free: a trivial text prompt spent **209 thought tokens and 16.5 s** wall clock. Budget this against the "60–90 s clip in under 2 min" demo target — 5 sequential calls of that shape is already ~80 s before any audio is processed. `thinking_level: "low"` is the lever if Phase 4 runs slow. **MEASURED 2026-09-08 on the real Phase 1 analyze stage, and the latency risk in SPEC §g is now confirmed rather than theoretical: one analyze call takes 63-70 s and spends 18,000-20,600 thought tokens against only ~2,200 output tokens.** Thinking is ~90% of the generated tokens and the dominant cost and latency term. It is also wildly variable on identical input: four runs of the same fixture spent 17,887 / 18,668 / 20,617 and — once — **1,864** thought tokens, that last one finishing in 15.7 s instead of 70 s. So a single stage can consume the whole "60-90 s clip in under 2 min" demo budget on its own, and the pipeline cannot be five sequential calls of this shape. Decide `thinking_level` with numbers at the end of Phase 2, as planned; the lever is now known to be necessary, not optional. Note the 15.7 s run also produced the *worst* segmentation of the four, so buying latency with `low` has to be judged on output quality, not just on the clock. **DECIDED 2026-09-08 at the end of Phase 2, with numbers.** `thinking_level: "low"` on the critique stage produces **exactly 0 thought tokens** — not merely fewer — and halves the call: **7.7 s vs 14.9 s**, same 2,490 in / ~960 out. Quality was checked on the artifact and not on the clock, per the caveat above: across the 8 fixture segments the two runs agree within 3 points on every score (fidelity 95-98 vs 95-96, naturalness 88-95 vs 82-95), both flag the same single segment (s04) as the weakest, and both quote the *same* translationese substring `"इस बात की कहीं ज़्यादा भरपाई कर सकता है कि"` as the reason. A stage whose job is to compare two texts against a published rubric does not need to think; a stage whose job is judgment does. So: critique runs at `low`, adapt and analyze stay at default. Adopting `low` on critique alone takes ~7 s off every job at no measured quality cost. **IMPLEMENTED 2026-09-08** as `CRITIQUE_THINKING_LEVEL` in `src/modules/localize/critique.stage.ts`, defaulted inside `runCritique()` rather than passed by each caller — the decision had been recorded here as "adopted" for several hours while every default run still paid the 14.9 s, which is exactly the doc-ahead-of-code drift this file exists to prevent. `--thinking=` still overrides it, and `test/adapt.test.ts` asserts the constant so the two cannot part again. | measured 2026-09-07, extended 2026-09-08 |

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
- **Retries and timeout — read from the SDK source 2026-09-23, then measured.**
  `interactions.create` already retries on its own: `attempt-count-backoff`, 4
  retries, 500 ms initial / 8 s max interval, on `408/409/429/5XX` and on
  connection errors (`dist/node/index.mjs`, `$do$g`). So SPEC §f's SHOULD item
  "retry with backoff on 429" is covered by the SDK and was not re-implemented.
  What it does NOT have is a timeout: the default is `timeout_ms: -1`. Passing
  `{ timeout: ms }` as the second argument works and applies **per attempt** —
  measured with `timeout: 1`: `APIConnectionTimeoutError` after 6.7 s total,
  i.e. the four backoff retries ran. `src/lib/gemini.ts` sets 150 s per attempt
  (`CALL_TIMEOUT_MS`; **300 s and `maxRetries: 2` since 2026-10-07** — the model
  was running at ~125 tokens/s and a 17 s clip's analyze took 101 s, so a 60 s
  clip's could pass 150 s honestly, and each timed-out try is thought again from
  scratch), so a hung call fails its job in at most ~13 min instead
  of holding it in flight forever (the orphan reaper skips this process's own
  running jobs by design, so nothing else would ever fail it).

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
| Pauses — **DOC IS WRONG for the leading position** | Docs: `markup` input with `[pause short]`, `[pause long]`, `[pause]`; "available for `hi-IN`". **Measured 2026-09-08 (Phase 3 spike): `[pause short]` at the START of an utterance produces NO measurable silence — −2.8%, inside the noise floor.** Inline it does something (+0.63 s in a probe). Use SSML `<break time>` instead, which is accurate in the leading position. **Corrected 2026-10-01: an INLINE `<break>` is not accurate and not harmless** — see § Synthesis rework. | https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd |
| Custom pronunciation | IPA / X-SAMPA via `custom_pronunciations`; available for `hi-IN`. | same |
| **SSML — RESOLVED 2026-09-08, and no page was right** | The three conflicting claims were: release note 2025-10-17 (only `<phoneme>`, `<p>`, `<s>`, `<sub>`, `<say-as>`), the Chirp 3 HD page (also `<prosody>`, `<break>`, `<voice>`, `<audio>`), and the voice-list page ("doesn't support SSML input"). **The measured answer: Chirp 3 HD on `hi-IN` ACCEPTS ssml input and parses its STRUCTURE, honours `<break time>` accurately, and IGNORES inline `<prosody>`'s rate attribute — inserting ~1.4 s of dead time per inline tag instead.** So the voice-list page is wrong (ssml is accepted), the Chirp 3 HD page is misleading (`<prosody>` is accepted and does not do what it says), and the release note is closest but still incomplete (`<break>` works and is not on its list). Full table below. | measured; see § Phase 3 spike |
| Full-SSML fallback | Neural2 / WaveNet voices support `<prosody rate|pitch|volume>`, `<emphasis level>`, `<break>`. Hindi Neural2 voices exist under `hi-IN`. | https://docs.cloud.google.com/text-to-speech/docs/ssml |
| Node SDK | `@google-cloud/text-to-speech` 7.0.0. Auth via ADC / service account. | npm |

## Phase 2 — adapt + critique, measured 2026-09-08

Everything here is from real runs on `fixtures/sample_60s.mp3` (63 s, 8 segments,
the Brachistochrone clip), not from the docs. Where it contradicts an assumption
recorded earlier in this file, the measurement wins.

| Item | Measured value |
|---|---|
| Adapt call shape | Telemetry note: the brief reports as its own `brief` stage from 2026-09-08 (SPEC section b enum amended in the same edit); before that it reported as `adapt`, which is why the per-call figures below had to be separated by hand. **One Gemini call per segment**, walked in order — the literal SPEC §b design, chosen over batching. Per-segment cost on the fixture: 2.8k-3.2k in, 370-600 out, 1.0k-3.6k thinking, **8.8-18.3 s** each. The brief (2a) is a further 1,668 in / 736 out / 1,695 thinking / 13.6 s. Input tokens climb across the clip (2,794 on s01 to 3,184 on s08, not strictly monotonic) because every prior adapted segment is carried forward as context — so the stage's input cost grows with segment count rather than staying flat. At 8 segments the climb is only ~14% and harmless; a 180 s clip at the SPEC's 4-12 s target is 25-45 segments, where it is worth re-measuring before Phase 4. |
| Adapt wall clock | **110.0 s for 8 segments** (1 brief + 8 adapt). This is the phase's headline cost and it dominates everything else. |
| Critique | One call for all 8 pairs: 2,490 in / 962 out / 2,509 thinking / **14.9 s** at default thinking, **7.7 s and 0 thinking at `low`** (see the Thinking row). |
| Retry | 8.7 s and 18.6 s for two `adapt_retry` calls. Same shape as an adapt call, as expected — it is the same prompt with a critique block appended. |
| Full Phase 2 wall clock | **138.5 s** for 8 adapt calls + 1 brief + 1 critique, with no segment failing the gate. 10 calls, 28,399 in / 5,574 out / 22,555 thinking. |
| **Demo budget: OVER** | 138.5 s for stages 2-3 alone at the time of measurement (critique at default thinking; with critique now defaulted to `low` the same run should be ~131 s — arithmetic from the 7.2 s delta, not a fresh measurement, and flagged as such until the next real run), and Phase 1's analyze adds a further 63-70 s, so a full run is **~205 s against SPEC §g's 120 s target**. This is a confirmed miss, not a risk. The levers, now that the numbers exist: critique at `low` (−7 s, free, adopted); adapt at `low` (untested — adapt is the stage where judgment actually lives, so this must be judged on the Hindi, not the clock); or batching adapt after all. Decide in Phase 4 when synthesis latency is also known. Recorded here so the Phase 5 demo is planned around a real number. |
| Structured output nesting | The SPEC §g risk "structured output rejects a deeply nested schema" **did not fire**, and for this stage it is now retired by construction: one call per segment means the model-facing schemas are `AdaptationBrief`, `AdaptedSegment` and `Critique`, each at most two objects deep. `Adaptation` is deeper but is assembled locally and never sent. `test/adapt.test.ts` asserts the depth so a future edit cannot quietly reintroduce the risk. |
| Hindi length drift — **SPEC §g open risk, now decided** | The risk row assumed Hindi runs 15-25% longer than the English. With a soft per-segment character budget in `adapt.v1.md` (source span × 13 est. Devanagari chars/sec), the fixture came out at **−2% overall (62.6 s source vs 61.5 s estimated), 0 of 8 segments outside ±25%**. So the drift is manageable by asking for it rather than by post-hoc rate-fitting, and Phase 3 does not need to compress `speaking_rate` to fit. **Caveat, stated because it matters: this is an ESTIMATE.** It divides a character count by an assumed constant, and the honest number needs Phase 3 to synthesize the audio and divide measured duration by the characters that produced it. Replace `ESTIMATED_CHARS_PER_SEC` in `src/modules/localize/drift.ts` with the measured value then. |
| Devanagari-only compliance | **0 of 8 segments** contained Latin script across every run. The rule in `adapt.v1.md` is being followed, and `findLatinRuns()` enforces it after the parse (not as a schema regex — a regex would discard a paid call for one stray word instead of routing that segment through the retry that already exists). |
| Blind critique — does it actually catch anything? | Yes, and this is the evidence that it is not decorative. On a run with the threshold temporarily raised to 85 to exercise the path, the critic flagged s04 at naturalness 78 and quoted the exact substring `"इस बात की कहीं ज़्यादा भरपाई कर सकता है कि"` as a calque of the English "make up for the fact that". The retry restructured it into a फ़ायदा/नुक़सान contrast — `"और यह फ़ायदा इस रास्ते के सीधी रेखा से काफ़ी लंबे होने के नुक़सान की कहीं ज़्यादा भरपाई कर देता है।"` — fixing precisely what was quoted and leaving the rest alone. Reproduced across two independent critique runs (default and `low` thinking), which both flagged s04 and both quoted the same substring. |
| Retry rate at the real threshold | **0 of 8 segments** fall below 70 on the fixture (fidelity 92-96, naturalness 82-95). The gate is real but does not fire on good input, which is the correct behaviour and also means the retry path needs a deliberately raised threshold to demonstrate. Do not read a 0% retry rate as the loop being untested — read `test/adapt.test.ts` and the run above. |

## Phase 3 spike — what Chirp 3 HD actually honours, measured 2026-09-08

`npm run spike:tts`. Every variant runs 3 times on one real sentence from
`outputs/adaptation.json` (184 chars, ~11 s), voice `hi-IN-Chirp3-HD-Kore`.
Raw data in `outputs/spike/spike-results.json`.

**Read the noise floor first.** Chirp 3 HD is generative and its output duration
is not reproducible: re-sending byte-identical input moved the duration by up to
**6.8%** within a single run (and 4.4% between runs, which is how this was
noticed). Every threshold below is derived from that measured spread rather than
chosen in advance, and nothing under it is treated as a finding. A single-shot
A/B on this API measures noise as confidently as it measures signal.

| Mechanism | Measured | Verdict |
|---|---|---|
| `<speak>` wrapper, no tags | +0.0% vs plain text | inert, as it should be |
| `audioConfig.speaking_rate` 0.85 | **+17.2%** | **works.** The segment-rate mechanism the stage uses |
| `<break time="3s"/>` | **+3.71 s** for 3.0 s requested | **works.** Predicted magnitude, hit |
| `<break time="350ms"/>` leading | **+0.30 s** for 0.35 s requested | **works.** The `pauseBefore` mechanism the stage uses |
| `<break time="150ms"/>` inline | +0.74 s | works, with ~0.6 s of boundary overhead beyond the request |
| `<prosody rate="1.0">` inline — **a semantic NO-OP** | **+12.8%** | **BROKEN. This is the decisive row.** A tag asking for the rate the voice already uses must change nothing |
| `<prosody rate="slow">` inline | +15.3% | indistinguishable from the no-op → the rate attribute is not read |
| TWO `<prosody>` wrappers vs one | 1.69x the effect | cost scales with tag COUNT, not with what the tags say |
| `<prosody rate="slow">` whole utterance | +34.8% (2.27x the two-word version) | consistent with a real global rate, but `speaking_rate` does this properly |
| `<emphasis level="strong">` inline | +14.2% | same magnitude as the no-op → same artifact |
| `<zzz>` (meaningless tag) | −5.0%, inside noise | unknown tags are stripped, not vocalized |
| `[pause short]` leading markup | −2.8%, inside noise | **produces no silence.** Contradicts the doc row above |

### How this spike got it wrong twice before getting it right

Recorded because the method matters more than the result, and because the wrong
answer shipped into `synthesize.stage.ts` before the right one did.

1. **Run 1 (one trial per variant):** every variant "changed the audio". No noise
   floor existed, so a 4.4% generative wobble and a real effect were the same
   observation. Fixed by running 3 trials and deriving the threshold from the
   same-input spread.
2. **Run 2 (3 trials, prediction test added):** `<break time="3s"/>` hit its
   predicted +3.6 s and the bogus `<zzz>` stayed inert, so the verdict was "SSML
   is genuinely honoured". Both observations were correct; the conclusion was
   not. Neither test distinguishes *the tag's meaning was applied* from *the
   presence of a tag changed the audio*. Stage 4 was built on that verdict,
   wrapped all 16 emphasis terms in `<prosody rate="0.85">`, and produced audio
   **41.3% longer** than the source span. Two 350 ms breaks and sixteen rate
   wrappers cannot cost 24 s, so the number was not drift — it was the bug
   reporting itself.
3. **Run 3 (no-op control added):** `<prosody rate="1.0">` moved the duration
   +12.8%. A rate tag that does something when it asks for nothing is not being
   honoured. Verdict reversed; `<prosody>` removed from the stage.

**The transferable lesson: a prediction test tells you a parser exists, a no-op
test tells you what it parses.** This spike had only the first and needed both.
`spike-tts.ts` now ships all four controls — noise floor, bogus tag, predicted
magnitude, and no-op — so the corrected verdict is reproducible rather than
remembered.

### Consequence for the pipeline

Per-term acoustic **stress** is not achievable on Chirp 3 HD `hi-IN`. SPEC §b's
conditional therefore resolves to its fallback branch, reached on evidence rather
than on the documentation conflict. What stage 4 uses, every element measured:

- segment rate ← `audioConfig.speaking_rate` from `ttsHints.speakingRate`
- `pauseBefore` ← `<break time="350|700ms"/>` at the utterance start
- emphasis ← a `<break time="150ms"/>` before **one** term per segment. This is a
  *pause*, which is a real teacherly device, and the schema field is named
  `emphasisPausedTerm` rather than anything implying stress. Remaining terms are
  highlighted in the UI and carry `emphasisNotRealized` in the artifact.

One term, not all of them, for a reason that is not cost: a speaker has one
prosodic peak per breath group, and 16 pauses is a stutter, not emphasis.

## Phase 3 — synthesis measured 2026-09-08

Real runs on the 8-segment fixture adaptation, `hi-IN-Chirp3-HD-Kore`.

| Item | Measured value |
|---|---|
| Per-segment TTS latency | 1.4–2.6 s per call, 135–220 billed chars each. No thinking, no tokens — Cloud TTS bills characters |
| Stage 4 wall clock | ~16 s for 8 sequential calls + ffmpeg concat + mp3 encode. Sequential deliberately: these calls ARE independent (unlike adapt) and parallelizing them is the obvious Phase 4 lever, but changing concurrency in the same commit that first measures the stage would make the per-segment number unreadable |
| Stage 4 cost | **1,356 billed characters** for the whole clip. At Chirp 3 HD pricing this is a fraction of a cent; recorded because SPEC §e sells per-call telemetry and a pipeline that stops counting at the last stage is not making that case |
| Concat is lossless | `output.mp3` is within **0.11 s** of the summed segment durations. The concat demuxer with `-c copy` on LINEAR16 WAV, then one mp3 encode. Per-segment MP3s would have inherited encoder padding at every join and broken exactly the measurement this phase exists to produce |
| **`ESTIMATED_CHARS_PER_SEC` retired** | Phase 2's arithmetic guess was **13**; measured plain-text rate on this voice is **12.72** chars/sec — **2% high**. `drift.ts` now exports `MEASURED_CHARS_PER_SEC = 12.72` and a unit test pins it to the docs. Phase 2's caveats were right to exist and its conclusion survives measurement |
| **Length drift — SPEC §g risk now MEASURED, not estimated** | Source span 62.6 s. The adapted Hindi as plain text at rate 1.0: **63.4 s, +1.2%** — so the character budget in `adapt.v1.md` works and the risk row's assumed 15–25% overrun does not materialise. With stage 4's pedagogical prosody applied: **69.8 s, +11.6%**, i.e. **+10.2% is time this stage adds on purpose** (8 emphasis pauses + 2 lead pauses ≈ 6.4 s, which closes the arithmetic). Measured with `--baseline`, which synthesizes every segment a second time as plain text purely to separate the two causes |
| Why the decomposition is not optional | "Our output is 41% too long" and "our output is 11% too long, of which 10 points are pauses we chose to insert" are different claims and only one is honest. The `--baseline` control exists so the stage cannot take credit for the adapter's budget or blame the adapter for its own pauses |

## Synthesis rework — measured 2026-10-01, from listening to the deployed demo

The demo's Hindi ran **70.1 s for a 63.1 s source**, segment ends sounded final
("dry"), and the voice audibly broke and restarted mid-segment. Measured on the
deployed demo job (`b176f8b2…`) and by re-synthesizing its exact Hindi:

| Item | Measured | Consequence |
|---|---|---|
| **Inline `<break time="150ms"/>` on Chirp 3 HD `hi-IN`** | `silencedetect` on the demo output: **0.78 s** and **1.07 s** holes where 150 ms was requested, at `…करने का ‖ सबसे तेज़…` and `हाँ, वो ‖ सबसे छोटा…`. Re-synthesizing s01 without it (2 takes each): 11.91/12.27 s → 11.64/11.76 s, and the 0.64 s hole is **gone**. The voice ends the text before the tag with a sentence-final contour and restarts after it | Phase 3 read "+0.59 s over the request" as an accurate-enough emphasis pause. It is a generation restart. **No inline tags at all** — every pause is now silence written by ffmpeg between calls |
| **A segment boundary mid-sentence** | Each request is spoken as a complete utterance: s02 ended `…एक्सेलरेट करती है,` and got a full stop's falling ending before s03 restarted. s01+s02 as one call: **19.36/19.44 s vs 20.94 s** as two | Segments are grouped into **utterances** that end at `। ? ! .` (or at a requested pause, or the 5,000-byte input cap) |
| `speaking_rate` as a fit lever | Duration scales ~linearly (0.85 → +17.2%, vs 1/0.85 = +17.6%); take-to-take noise ±3% | An utterance that would run into the next one's source start is re-taken once at a faster rate, capped at ×1.15 of the adapter's rate |
| **Result on the same Hindi** | **63.18 s for a 63.11 s source** (was 70.1 s). 6 utterances for 7 segments, 4 re-taken at 1.03–1.15. Silences ≥ 0.5 s: 15 → 6, all at sentence ends or requested pauses. Stage wall clock 8.8 s | Output now matches the source length and each utterance starts no earlier than the English it replaces, so the Hindi tracks the video |

## Phase 4 — the pipeline behind the API, measured 2026-09-10

`npm run e2e:localize` on `fixtures/sample_60s.mp3`, real Gemini + Chirp 3 HD, through
`POST /api/v1/localize/jobs` and 2 s polling (so each stage time is ±2 s).

| Item | Measured value |
|---|---|
| **Wall clock, upload → done** | **Three runs: 237.9 s, 226.8 s (uploaded through the browser UI), 215.8 s** — against SPEC §g's 120 s. First run: analyze 84.4 s · brief + adapt (9 segments) 136.9 s · critique 8.0 s · synthesize 6.1 s. The Phase 3 CLI run was 180.4 s; this run's analyze produced 9 segments rather than 8 and spent more thinking (48,046 thought tokens across 12 calls vs 35,508 in / 8,496 out), which is the variance Phase 1 already recorded (the third run: analyze 54.3 s, adapt 146.9 s for 10 segments, 37,204 thinking) — the API adds no measurable overhead of its own (ingest + storage + DB writes are inside the 2 s poll granularity) |
| Stage 4 with concurrency 4 | **6.1 s** for 9 segments, down from ~16 s for 8 sequential in Phase 3. `SYNTH_CONCURRENCY = 4` in `synthesize.stage.ts`; per-segment `latencyMs` still records each call alone, so the per-segment cost reads as before |
| Where the budget goes | ~93% is analyze + adapt, i.e. thinking. The levers left (`low` on adapt, batched adapt) change the Hindi, so they are to be judged on the Hindi, not pulled for the clock. The demo path is the pre-computed `/demo` job, which costs no model calls |
| Output | 73.2 s of Hindi for a 63.1 s source span (+16%), 1,455 billed TTS chars; overall fidelity 93, naturalness 88; 0 segments retried at the real threshold; 8/15 emphasis claims backed by a measured energy rise |
| Range | `GET .../audio/output` with `Range: bytes=0-1023` → 206 with 1,024 bytes; the full download ffprobes at the same 73.2 s the job reports |

Found while building it, recorded because each would otherwise resurface:

- **@fastify/multipart does not always error on an over-cap stream.** With
  `limits.fileSize` set and the part's stream piped to disk, a 26 MiB upload arrived
  *truncated* without the pipeline rejecting, and surfaced as ffmpeg refusing to
  decode — a 400 "not audio" for a file that was merely large. The route now checks
  `part.file.truncated` after the write as well as catching
  `RequestFileTooLargeError`. The integration suite pins the 413.
- **Every 429 in the API was a 500.** `plugins/security.ts`'s
  `errorResponseBuilder` returned the house envelope (`statusCode: -1`); the
  rate-limit plugin *throws* whatever that returns, so the error handler read
  `statusCode: -1` as the HTTP status. It now returns an `AppError(…, 429)`. This
  affected sign-in's limiter too; nothing had tested an exceeded limit before the
  localize suite's jobs-per-hour test.
- **Devanagari needs a shipped font.** A machine with no Devanagari face renders
  every Hindi string as tofu. `web/` now self-hosts Noto Sans Devanagari via
  `next/font` for `[lang="hi"]` and as a per-glyph fallback in the base stack.
- **A nested Fastify `register(plugin, opts)` re-applies `opts.prefix`.** Passing a
  parent plugin's options through mounted every route at
  `/api/v1/localize/api/v1/localize/*` — found by the first e2e run's 404.

## Nine more clips — measured 2026-10-06

Until this date the pipeline had only ever run on `fixtures/sample_60s.mp3`.
Nine third-party excerpts (`fixtures/clips/`, gitignored, 17–60 s: accented
English, dense jargon, two TEDx talks, a Q&A, a flat promo, slow explainers)
were run through the same stage sequence as `runJob()`.

| Question | Finding | Consequence |
|---|---|---|
| Does it run at all on other material? | Yes. Six clips completed before the Gemini spend cap ended the batch (below); the other three completed afterwards. No overlapping or inverted segments, no Latin script reaching TTS, latest Hindi start 1.19 s behind its source | No structural change needed |
| **Gemini spend cap** | A third billing 429, distinct from the two in the Billing row: `Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend`. It is a per-project monthly dollar cap set in AI Studio, and prod shares the project (deploy.sh copies the same key to Secret Manager), so a local batch can take the deployed site's uploads down with it. The SDK retries it four times first: one call took 464 s to fail | Check https://ai.studio/spend before a demo, as with the prepay balance |
| **Corroboration could not fail** | 54 of 54 emphasis claims "supported" on the first six clips. Two causes. (1) The threshold ladder was tuned on the fixture: on 7 of 9 clips no rung reached the 6–15 pauses/min band, and the fallback kept the rung with the MOST pauses — 21–48 a minute. (2) A claim was checked against its whole 4–12 s segment, and at that density every segment contains a pause | Ladder extended to mean−24; the fallback is now the last rung over the band, cut to its longest pauses. Analyze returns `atSec` per stressed term and the check looks at ±0.75 s around it. Prominence is measured from the median of speech windows (above mean−6 dB), not of all windows: three clips had marked 29–31% of windows prominent |
| Corroboration after the fix | Four clips re-run: **32 of 43 claims supported (74%), 22 by an energy rise**, 11 unsupported; per clip 12/14, 6/10, 10/14, 4/5. The fixture's own measurement is unchanged (mean−6, 9 pauses) | The rate can now move, which is the point of publishing it |
| Fillers reached the voice | Analyze transcribes verbatim, and adapt carried "um"/"uh" into Hindi as "उम"/"अह", which a TTS voice reads as words | `adapt.v1.md` drops fillers, false starts and clip-edge stubs; `critique.v1.md` is told that is not a fidelity loss (it had scored a dropped false start at 85) |
| **`low` thinking on adapt — tested, REJECTED** | The lever the Demo budget row left "untested". Same clip, same analysis and brief, three levels: `low` 72 s / 0 thought tokens / naturalness 88 (lowest segment 82); `medium` 172 s / 12.1k / 93 (90); `high` 330 s / 31.9k / 92 (84). At `low` the critic quoted real calques that `medium` did not produce ("या उस मामले में किसी जॉब में" for "or a job for that matter", an idiom stage 1 had flagged), and on the accented clip `low` left Latin script in 5 of 9 segments ("student", "ID"), which cost an 86 s retry round; the same clip at default had none. Default thinking spends what `medium` does (1.6–2.2k per call) | Adapt stays at the model's default. `high` buys nothing. The 120 s target stays missed for live uploads: 215–240 s on a 60 s clip, as in Phase 4 |
| Wall clock on an idle key | 237 s for a 60 s clip run alone (analyze 31 s, brief 24 s, adapt 156 s for 6 segments, critique 13 s, synthesis 11 s). The first batch's 296–525 s was three clips at once on a key about to hit its cap, and is not a pipeline number | — |
| Not fixed, known | The critique gate (< 70) did not fire on any of the nine clips at default thinking; lowest fidelity seen was 85. Two speakers in a clip become one voice (**addressed 2026-10-07**, § Speakers and voices). Digits ("250,000", "90%", "बी2बी") go to the hi-IN voice as written and nobody has listened to how they are read | Listen before demoing a clip with numbers in it |

## Dub audit — sync and voice, measured 2026-10-06 with no model calls

The Gemini takes four clips had already been paid for (accented English, dense
jargon, the flat control, slow-deliberate) were replayed through the real
`runSynthesize()` with `generateSpeech` swapped for a reader of the stored WAVs
— the replay reproduces the paid runs' placement to 0.0000 s — so everything
after the TTS call could be measured before and after a change for free. The
swap was a `module.registerHooks` resolve hook in a throwaway script, not a
seam in the stage. The takes are kept in `outputs/dub-audit/takes/`
(gitignored), with before/after videos beside them. The other five fixture
clips have no Gemini-voice take on disk: the last batch failed at ingest on a
moved file, before any call.

| Item | Measured | Consequence |
|---|---|---|
| **Loudness was never a static gain** | Pass two of loudnorm reported `normalization_type: dynamic` on 6 of 6 stored dubs. `linear=true` is honoured only if the gain keeps the true peak under the ceiling, and a TTS join peaks at −0.5 to −1.3 dBTP at −16 to −22 LUFS. The gain applied per sentence ranged **+0.7 to +3.8 dB** inside one clip (spread 2.1 / 3.1 / 2.1 dB on three clips); loudness range 7.3 → 5.3 LU | `loudnessGainFilter()`: one `volume` gain, and `alimiter` only when the peak needs it. Same takes after: spread 0.5 / 0.4 / 0.3 dB, range 7.3 → 7.0 LU, still −16.2 LUFS. Also applies to the English video track |
| **The Hindi shipped at 16 kHz, twice lossy** | `output.mp4` carried AAC 16 kHz at 54–74 kbps, encoded from the 16 kHz MP3. The voice's 9–12 kHz band: −48 dB as synthesized, **−87 dB** as shipped. The English beside it is 48 kHz | A 24 kHz lossless master; mp3 at 24 kHz; mp4 muxed from the master. After: −46 dB. The encode chain adds 0.0 ms either way (cross-correlated) |
| **An upload whose audio starts late lost the offset** | Synthetic mp4, audio stream starting 0.48 s after the video: a beep at 2.00 s of the picture was at 1.53 s in `source.mp3`, so the whole dub would sit 0.48 s early under the video | `aresample=async=1:first_pts=0` in `encodeMp3`: 2.01 s. On a normal clip the mp3 is sample-identical. None of the nine fixtures has this (0–41 ms) |
| 2% overrun tolerance | Left from the re-take design. It let the next sentence start up to 2% of a slot late (0.28 s on 14 s) | Removed; the last utterance is exempt from the breath instead |
| Cues against the teacher's real speech | One stored analysis per clip, all nine: 55 of 57 interior segment starts sit in a measured pause or within 0.12 s of its end. But the model puts the boundary anywhere in the pause: Hindi starts **1.52 s and 1.01 s before the teacher resumes** on the key-term clip (1.8 s dramatic pauses), 0.33–0.61 s early on all six interior cues of one TEDx clip, and 0.51 s before the first word of the brachistochrone clip | **Fixed 2026-10-07** — § Cues and phrases |
| **Where the dub is out of step: inside the slot** | Teacher talking over a silent dub: **15.1 s of 60** (accented), **13.5 s** (dense jargon), 1.5 s of 17 (flat control); the dub talking over the teacher's pauses: 12.5 / 5.4 / 1.9 s. Each sentence starts on cue, is said in one block, and waits. A lecturer at 63 wpm spreads 13 words over 12.4 s; the Hindi says them in 6.0 s, and names the key term about 5 s before the teacher does (`atSec` 21.7 against a take that ends at 16.8) | Tempo cannot: the ×0.9 slow-down runs on 5 of 8 and 5 of 7 sentences and recovers 2.3 s and 1.1 s. Phrase placement was built 2026-10-07 and fixes the key-term timing, **not** this total — § Cues and phrases says why |
| Does the voice follow "about N seconds"? | 45 takes: correlation 0.37 between the length asked for and the length spoken; spoken ÷ predicted ranges 0.62–1.26. Two takes of identical text and direction differ by up to 19%. "Slow and deliberate" produced a take at 12.0 chars/s against the 10.97 average | Direction is not a timing control. A second take chosen for length would be (25 audio tokens/s, about half a cent per 10 s), and is untested |
| The pause before a warning | Teacher paused 0.60 s; adapter asked `long`; the dub left 0.23 s, because the previous sentence may fill its whole slot. On the run budgeted at the old rate every gap was the 0.12 s breath | **Not fixed.** `pauseBefore` could shorten the PREVIOUS utterance's deadline rather than delay the next cue |

## Cues and phrases — built and measured 2026-10-07, again with no model calls

Two changes to where the Hindi lands, both checked on what was already paid
for: the nine stored analyses (one per fixture clip, now kept with the takes in
`outputs/dub-audit/takes/`) for the first, and the Gemini takes of four clips
replayed through `runSynthesize()` for the second.
Judged by a detector the pipeline does not use (10 ms RMS frames on the source
audio), so the anchoring is not graded by the list it anchors to.

| Item | Measured | Consequence |
|---|---|---|
| **Segment edges anchored to the measured pause** (`anchor.ts`) | 96 of 132 edges moved (the last segment's end is never one of them). Mean distance from a Hindi cue to the teacher's real onset: **0.167 s → 0.048 s** over 66 cues; cues more than 0.25 s early: **16 → 4**. Key-term clip: worst 1.52 s → 0.03 s. Replayed on stored takes, speech/silence agreement 54 → 59% (accented), 69 → 70% (dense jargon), 80 → 80% (flat control), no cue late | Done in `runAnalyze`, after corroboration. The stored analysis carries measured edges; the model's are in `Corroboration.boundaryAnchors` |
| What it does to the Hindi budget | The teacher's pauses stop counting as speaking time: −1% to −14% per clip (−9% on the key-term clip, −14% on one TEDx talk). The key-term clip's two pause-led segments went 55 → 30 and 55 → 35 characters | The retry gate measures against the slot to the NEXT cue instead, so this buys no extra adapt calls. (**Corrected the same day:** at 30% over the slot it let through text that cannot be said — § Speakers and voices, the paid run. It is now the ceiling, 15% over.) **Unmeasured:** whether Gemini writes to the smaller number. Needs one paid adapt run |
| The 4 cues still early | (a) ffmpeg `silencedetect` is per-sample, and on one TEDx clip its pauses end up to 0.5 s before the RMS level says speech starts (a breath or a click, most likely; not listened to). (b) The brachistochrone clip opens on 0.51 s of music bed at −39 to −66 dB mean with −28 dB peaks: quiet, and not a "pause" to ffmpeg at all, so there is nothing to anchor the first cue to | Left. Merging pauses 0.1 s apart moved the mean 0.048 → 0.040 s and was not worth a second rule. An RMS-based pause detector in acoustics.ts would fix both; it would also change what stage 1 is shown |
| Tolerance | 0.15 s, not corroborate's 0.3 s. Every near miss measured was ≤ 0.12 s; at 0.3 s a cut with a word between it and the pause gets moved past the word | A cut in running speech (2 of 57) stays the model's |
| **Phrases placed against the teacher** (`placePhrases`) | The voice pauses ≥ 0.25 s inside a take 66 times in 45 takes, at −49 dBFS or quieter (median) against −8 to −16 for speech; 27 of 36 checked fall on the Hindi's punctuation. Held on 4 of 27 replayed utterances, by 1.0–4.1 s. Stressed terms (31, teacher's time from `atSec`, Hindi's from the term's place in the text): mean gap **1.08 → 0.89 s**, worst **5.8 → 2.8 s**. "सुपरवाइज़्ड लर्निंग": 6.0 s before the lecturer → 1.8 s. The cuts are sample-identical to the take outside a 5 ms fade and sit at −68 dB or lower | A held phrase starts on the teacher's own onset. What was a block and a wait is a sentence with the lecturer's pause in it |
| **What phrase placement cannot do** | Teacher talking over a silent dub: 13.8 → 14.0 s (accented), 13.0 → 12.6 s (dense jargon). A brute-force search over every possible hold, scored against the teacher's actual speech, gets the dub's speech-in-silence from 19.7 s to **17.6 s at best** across three clips; `placePhrases` reaches 19.4. The accented speaker pauses 46 times a minute; his Hindi takes have one or two places to cut | The remaining 13–14 s a minute is not a placement problem. It is rhythm (a voice that pauses as often as the teacher) and length (Hindi 3–8 s a minute shorter than the teacher's speech), both of which are TTS- or adapt-side and cost calls to try |
| The full pause list | The ladder keeps only the 15 longest pauses a minute on a dense clip. Handing `placePhrases` every pause instead changed nothing: the same 4 utterances were held | Not the limit. Left as it is |

## Speakers and voices — built 2026-10-07, NOT yet run against a model

Reported from listening to `control-flat_umault`: a woman on screen, a man's
voice; two people speaking, one voice. Checked in the frames and the stored
analysis: she presents to camera and asks "Hey Lou, what you writing?", a man at
the whiteboard answers "I have no idea." — and stage 1 had put both in one
segment, with nothing anywhere saying who spoke.

| Item | Verified value | Source |
|---|---|---|
| Voice names by gender | **Female:** Achernar, Aoede, Autonoe, Callirrhoe, Despina, Erinome, Gacrux, Kore, Laomedeia, Leda, Pulcherrima, Sulafat, Vindemiatrix, Zephyr. **Male:** Achird, Algenib, Algieba, Alnilam, Charon, Enceladus, Fenrir, Iapetus, Orus, Puck, Rasalgethi, Sadachbia, Sadaltager, Schedar, Umbriel, Zubenelgenubi. The table is Chirp 3 HD's; the pipeline already relies on Gemini TTS sharing these names (its fallback is `hi-IN-Chirp3-HD-<same name>`) | https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd |
| Can Gemini tell speakers apart from audio? | The audio guide's own transcription prompt asks for it: "Identify distinct speakers (e.g., Speaker 1, Speaker 2)." Nothing documented about reporting how a voice sounds | https://ai.google.dev/gemini-api/docs/audio |
| Why not measure it instead | Tried: autocorrelation pitch per 0.5 s on this clip reads 190–320 Hz throughout, the man's line included, and 400 Hz where there is only music. A promo with a music bed is exactly where a pitch tracker cannot corroborate the model | measured |
| Defaults | Female `Kore`, then `Aoede`; male `Charon`, then `Puck`. Kore is the voice the product used on Chirp until 2026-10-06, so it has been listened to in Hindi; Aoede and Puck have not | project choice |

**What is verified:** the casting, the cut at a change of speaker, the direction
for a line that is not the teacher's and the notes stages 2 and 3 receive — as
unit tests, and end to end through `runSynthesize()` with stored takes standing
in for the audio (the two speakers' utterances requested `Kore` and `Charon`).
**What is not:** whether `gemini-3.8-flash` reports speakers and `voice`
correctly, whether it honours "one segment, one speaker", whether adapt then
writes agreeing first-person forms, and how Gemini TTS `Kore` sounds in Hindi.
Every one of those needs a paid call. The 17 s clip end to end is about $0.20
by the per-call figures above.

### The paid runs — `control-flat_umault`, 2026-10-07, both approved by Omkar

**Run 1, the whole pipeline:** 8 Gemini calls + 4 TTS calls, **$0.142** by the
usage each call reported (25,487 in / 4,000 out / 25,357 thinking; TTS 1,953 in
/ 542 audio tokens). Artifacts and raw takes:
`outputs/dub-audit/runs/control-flat_umault-speakers/`. **Run 2, stage 2
onward on run 1's analysis and brief:** below the table.

| Question | Result |
|---|---|
| Does stage 1 report the speakers? | Yes: `A` female, "the presenter, addressing the camera"; `B` male, "colleague writing on the whiteboard". Correct against the frames |
| Does it cut at the change of speaker? | Yes: "I have no idea." is its own segment, 7.14–8.16 s after anchoring, where the earlier run had it inside an 8.5 s segment of hers. 4 segments instead of 3 |
| Does the brief pick it up? | "A woman presenting directly to camera … her colleague is a deadpan, brief male counterpart acting as a comedic foil" |
| The cast | Her three utterances were requested in `Kore`, his in `Charon`, all four spoken by Gemini TTS (no Chirp fallback). His line was directed as "not the teacher … colleague writing on the whiteboard" |
| Hindi grammar | "अरे लू, क्या लिख रहे हो?" (to a man, correct). Nothing in this clip is first person singular, so the agreement rule itself went unexercised. Critic: fidelity 95 ×4, naturalness 92–95, no speaker issue raised |
| Analyze cost with the longer prompt | 3,100 in / 995 out / **12,139 thinking**, 101 s for a 17 s clip. Slower than the 63 s fixture's 63–84 s; one sample, and thinking varies 10× on identical input (Thinking row) |
| **What it broke: timing** | Her first line came back at 103 characters for 7.14 s, where 90 can be said with the ×1.15 speed-up spent. It ran 0.83 s into his cue, and the next two lines started 0.24 s and 0.45 s late. Before speakers, her line and his shared one 8.5 s utterance and nothing was late. Finer segments mean more cues to miss |
| Why the gate missed it | "30% over the budget", measured since yesterday against the slot to the next cue: 104 characters. It passed by one. Thirty percent over was never something stage 4 could absorb | 
| Fixed after run 1 | The gate is now `charCeiling` — the voice's pace × 1.15 over the slot. It would have sent the 103-character line back |
| Proper nouns | This run heard "We're Umult" and wrote "उमल्ट" (run 2: "यूमल्ट"); the earlier one heard "Umault" → "यूमॉल्ट". The logo on screen says umault. Stage 1 is audio only |

**Run 2 — and a prompt change that had to be taken back.** For run 2 the adapt
input also carried `Hard limit: N characters` (the ceiling, stated up front, so
the first attempt could meet it). Measured against run 1 on the same four
segments:

| | Run 1 (budget only) | Run 2 (budget + hard limit) |
|---|---|---|
| Her first line | 103 characters, ceiling 90 | **84** — under it |
| Thinking per adapt call | 1,154–1,622 tokens | **2,681–13,241** |
| Latency per adapt call | 18–23 s | 41–107 s |
| Adapt cost, four segments | $0.039 | **$0.109** |
| The line that could not fit (55) | 82, then 65 after its retry | 65 at once, after 13,241 thinking tokens |
| Its retry | 55.8 s, 6,390 thinking | **stopped by hand after 6.5 minutes without returning** |

The limit works and costs three times as much: the model cannot count
Devanagari letters, so it deliberates instead, and on a line that cannot fit it
does not stop. At 150 s a try and four SDK retries, one such call can hold a
job for 12 minutes; what the abandoned tries billed is not in any number here
(check https://ai.studio/spend). **The hard-limit line is removed again**; the
gate at the ceiling stays, because that is arithmetic. A cheaper way to make
the first pass shorter on fast speakers — a word count rather than a letter
count, a relative instruction — is untried.

Run 2 was finished with stage 4 alone: three TTS calls ($0.009) plus run 1's
take for the unchanged line. Counted cost **$0.121**. Result, same clip, same
voices: her first line ends 0.21 s before his cue (it ran 0.71 s past it); his
reply is on its cue (was 0.83 s late); three of four lines on cue and the last
0.21 s late, behind the one line still over its ceiling. Speech/silence
agreement with the original: 78% → **87%**, against 80% for every
single-voice version of this clip.

## Gemini 3.8 TTS — tried and adopted 2026-10-07

Omkar asked whether the stable model had been tried and what it cost, then to
use it. Eight calls on the Umault clip's four lines ($0.029) settled how.

| Item | Verified value | Source |
|---|---|---|
| Price | `gemini-3.8-flash-tts`: **$0.50** text in / **$9.00** audio out per 1M tokens through 31 Dec 2026, then $1.00 / $18.00. `gemini-3.8-flash-lite-tts`: $0.50 / $6.00, then $1 / $12. `gemini-3.1-flash-tts-preview`: $1.00 / $20.00. Voice was 9–21% of a job's cost on the preview, so the saving is about two cents a minute of video | https://ai.google.dev/gemini-api/docs/pricing |
| The request form | `input: [{type: "user_input", content: [{type: "text", text, annotations: [{type: "speech_metadata", style}]}]}]`, `response_format: {type: "audio"}`, `generation_config.speech_config: [{voice, language}]`. Reply `output_audio.data`, `audio/wav`, 24 kHz. **Works on the pinned SDK (2.21.0) at runtime**; its typings have `user_input` but no annotation type, so `lib/gemini.ts` builds the body as a plain object. `language: "hi-IN"` is accepted | measured, 4 + 8 calls |
| **The old prompt cannot be reused** | Sent what the 3.1 preview is sent — `speak.v1.md`, delivery notes, then the passage, as one text — the 3.8 model **read the notes aloud**: 46.6 s for a 7.7 s line, 29.9 s for 5.9 s, 25.5 s for 3.6 s (ratio 5–7×). Changing `GEMINI_TTS_MODEL` alone would have had every take fail the length check and every line fall back to Chirp, with nothing saying so | measured |
| The passage with a one-line style | Same lines: 0.98, 0.99, 1.06 of the length their text predicts. 217–264 input tokens a call, 5.7–8.3 s | measured |
| Through the real stage, a 60 s clip | 8 utterances, all Gemini, all on cue; natural lengths −27% to +14% against the 3.1 takes of the same Hindi (median +6%); voice stage **$0.0148 against $0.0337**, 21 s | measured |
| Why leave the 3.1 preview | Besides price: on the key-term clip **2 of 7 utterances fell back to Chirp** on the preview (a failed call or a take outside the length bounds; the stage does not say which) | measured |

`PROMPTED_TTS_MODELS` in `lib/gemini.ts` names the previews that take notes in
the prompt; any other model gets the passage with a style
(`buildSpeechStyle`, the house phrase in `speak.v2.md`). Nobody has compared
how the two models SOUND: Omkar chose 3.8 without a listening test, and the
videos in `outputs/dub-audit/runs/batch-current/` have both
(`output.mp4` on 3.8, `output-3.1.mp4` on the preview) for when someone does.

## Five clips end to end on the current code — 2026-10-07

Omkar capped the run at five. Speakers, anchoring, phrases, the ceiling gate and
(after a voice-only redo for three of them) `gemini-3.8-flash-tts`. Artifacts in
`outputs/dub-audit/runs/batch-current/<clip>/`; `output.mp4` is the 3.8 voice,
`output-3.1.mp4` the preview's where both exist.

| Clip | Speaker → voice | Lines on cue | Fidelity / naturalness | Cost | Notes |
|---|---|---|---|---|---|
| Q&A (Sapolsky) | male → Charon | 8 of 8 | 94 / 91 | $0.199 | One speaker in this excerpt, by the model and by pitch (95–170 Hz throughout); the "Q&A" in the name is the lecture, not the cut |
| TEDx (Atencio) | **female → Kore** | 6 of 9; last three 0.8–1.0 s late | 97 / 95 | $0.159 | Fast speaker: 4 lines at ×1.15. First person came out feminine ("कोशिश करती"); the brief wrote the rule into its own persona |
| Key-term (Yale) | male → Charon | 7 of 7 | 95 / 93 | $0.176 | Two phrases held 2.0 s and 2.1 s for the lecturer; 6 of 7 slowed |
| Dense jargon (CS229) | male → Charon | 6 of 6 | 96 / 94 | $0.171 | One line over its ceiling, retried once: 77 s, 8,954 thinking tokens |
| Accented English | male → Charon | 8 of 8 | 96 / 93 | $0.154 | — |

- **Cost:** $0.95 for the five ($0.79 model calls, $0.064 voice on 3.8, $0.093
  for the preview voice on the three clips redone). **$0.15–0.20 per 60 s
  clip**, not the $0.30–0.45 estimated beforehand. 5–7 minutes each.
- **Analyze latency:** 42, 69, 87, 140 and 147 s. The last was three seconds
  under the 150 s timeout in force until that morning.
- **Pace of the 3.8 voice:** 11.39 chars/s pooled over four clips (10.5–13.7 by
  clip), against the 10.97 the budget uses. It varies by clip more than by
  model; the constant is left alone.
- **Where it is still late:** the TEDx talk, and only on the 3.8 takes — one
  line came back 9.9 s where the preview gave 8.5 s, and the three after it
  never caught up. Take-to-take length is the cause, not the pace. A second
  take when the first cannot fit costs about 0.2 cents on 3.8 and is untried.

## Pace and second takes — built and measured 2026-10-07

Omkar watched the five 3.8-voiced videos and named one fault: "at times when
the speaker is saying something there is no audio being played". Everything
below was measured on those videos and their takes. Paid calls: 28, $0.060
(table at the end); all but the first three approved beforehand.

**The yardstick.** 10 ms RMS frames of the source at the clip's own silence
threshold and of the dub at its 95th percentile − 30 dB; gaps under 0.2 s
filled. A *stretch* is the teacher above threshold with the dub below it. A
stretch of 0.6 s or more is counted as visible.

**What was wrong.**

| Finding | Measured |
|---|---|
| Visible stretches, five clips | 33, 34.6 s in all, the longest 2.8 s |
| …of which the line was over and the teacher still talking | 21 stretches (24.5 s) after 17 of 38 lines |
| …of which a pause inside the line | 12 |
| Is the Hindi too short? | No. 85% of its character budget overall. 14 of 38 lines are under 80%, and in each the English is fillers and restarts ("Um, uh, so I don't want to waste too much of my time, uh, to to rush…") that should not be translated |
| Is the voice too fast? | Yes. Asked for "a natural, lively pace", `gemini-3.8-flash-tts` read at **8.7 to 17.3 chars/s** on single lines (11.39 pooled). A lecturer who took 14.0 s over a sentence was dubbed in 9.34 s |
| What the re-time could do | ×0.9 at most, already applied to 6 of 7 lines on that clip |
| Did the phrase holds cause it? | Partly: two holds on the key-term clip left the lecturer talking for 1.2 s and 1.6 s while the Hindi waited. With longer takes the Hindi is less far ahead and the holds shrink |

**The voice does slow down when asked.** Same line, same voice, only the pace
words in the style line changed; length over the natural take's:

| Pace (words in `pace.v1.md`) | Lines | Mean | Range |
|---|---|---|---|
| `brisk` — "quick and light" | 4 | ×0.89 | 0.84–1.01 |
| `unhurried` — "slow and deliberate" | 7 | ×1.15 | 0.99–1.28 |
| `slow` — "speaking slowly and unhurried, with a clear pause between phrases" | 11 | ×1.51 | 1.20–1.89 |

- A pace is a request. One 23 s line asked for `unhurried` came back at ×0.99.
- It is not a multiplier on whatever came before: the two lines whose FIRST
  take was `unhurried` gained only ×1.06 from `slow`. Lines the voice already
  reads slowly (about 9 chars/s) do not slow much further.
- `slow` is slower speech, not just longer pauses: speech time itself was 29%,
  54% and 61% longer on three lines, pauses 0.5 to 2 s longer in total.
- "speaking slowly and unhurried" without the pause clause was tried on the
  same three lines: ×1.34, 1.47, 1.60 and the same pauses (0.76, 0.79, 0.89 s
  the longest, against 0.84, 0.57, 0.71). Shorter and no better; not adopted.

**What was built** (`synthesize.stage.ts`, § Pace; SPEC stage 4).

- Every take is rehearsed on its cue: re-timed, phrases placed against the
  measured pauses, and the seconds of silent lips counted with 0.4 s of grace a
  stretch. A take that is too short or would make the next line late is
  recorded again at another pace, three takes at most, best fit kept.
- The re-time now aims at what the rehearsal found, not at 80% of the slot.
- Tried and dropped: choosing the FIRST take's pace from the character count.
  In a dry run it asked for `brisk` on lines whose natural take already fitted
  (the count is off by a quarter or more on one line), and a wrong guess that
  fits is never corrected. The first take is asked as before and measured.
- Tried and replaced: judging a take by its length alone. A 7.0 s take for
  8.3 s of speech passed, and left 2.8 s of silent lips: the lecturer paused,
  on and off, for 3.4 s in the middle, and the take had no pause of its own to
  wait at.

**What it did**, same five clips, same Hindi, first takes reused:

| Clip | Visible stretches | Seconds | After a line had ended | Lines late |
|---|---|---|---|---|
| Key-term (Yale) | 10 → 7 | 12.5 → 5.5 | 8 → 1 | 0 → 0 |
| Dense jargon (CS229) | 10 → 9 | 12.0 → 8.4 | 7 → 2 | 0 → 0 |
| Accented English | 6 → 1 | 5.4 → 1.0 | 4 → 1 | 0 → 0 |
| Q&A (Sapolsky) | 5 → 3 | 3.4 → 2.1 | 1 → 0 | 0 → 0 |
| TEDx (Atencio) | 2 → 1 | 1.3 → 0.7 | 1 → 1 | 3 → 0 |
| **All** | **33 → 21** | **34.6 → 17.7** | **21 → 5** (17 lines → 5) | **3 → 0** |

- Longest stretch 2.8 s → 1.4 s. No Chirp fallback. 38 lines took 57 takes: 15
  recorded twice, 2 three times. Kept: 21 natural, 14 slow, 2 brisk, 1
  unhurried. The two-speaker clip's one late line (0.30 s) is on cue as well.
- **What got worse:** pauses INSIDE a line, 12 → 16. A slow take pauses 0.6 to
  1.4 s between phrases where the teacher does not. Shortening such a pause
  where the teacher talks through it is untried; so is a tempo under ×0.9.
- **What is left after a line ends (5):** three lines where even `slow` is too
  quick for a teacher speaking that slowly (4.0 s over "All the readings are on
  the internet"), one cut mid-sentence by the end of the clip, one of 0.7 s.
- **Cost.** About half as many TTS calls again: roughly $0.009 a minute of
  video on top of $0.013. A second take took 6 to 14 s; one took 75 s.
- **Not run:** the prompted (3.1 preview) request form with these paces. It is
  sent the same words in its notes; nothing has been recorded with it.

| Paid calls | Calls | Cost |
|---|---|---|
| Does the voice slow at all? (three lines, before asking — not approved) | 3 | $0.0080 |
| What `unhurried` and `brisk` do | 6 | $0.0124 |
| Second takes, five clips | 12 | $0.0213 |
| Third takes | 2 | $0.0079 |
| The other `slow` wording | 3 | $0.0074 |
| Two-speaker clip; one take after the final numbers | 2 | $0.0029 |
| **Total** | **28** | **$0.0599** |

Every take is kept (`outputs/dub-audit/runs/batch-current/<clip>/`,
`runs/pace-cal/`), so the stage can be re-run over them for nothing.

## Cloud Run

- Request timeout default 300 s, max 3600 s. Jobs run async; never block a request on the pipeline. https://docs.cloud.google.com/run/docs/configuring/request-timeout
- Cannot host Postgres (no persistent disk, scale-to-zero). DB options in priority order: Cloud SQL on credits → user's US VPS with `compose.prod.yml` → Supabase. **Chosen 2026-09-11: Cloud SQL**, `db-f1-micro` (ENTERPRISE edition — Postgres 17 defaults to ENTERPRISE_PLUS, which has no shared-core tier), no authorized networks; Cloud Run reaches it through `--add-cloudsql-instances` at `/cloudsql/<conn>`, and the runtime SA needs `roles/cloudsql.client`. node-postgres appends `.s.PGSQL.5432` to a directory `host` itself. https://docs.cloud.google.com/sql/docs/postgres/connect-run
- **Response cap too: "Maximum HTTP/1 response size: 32 MiB per response. Limit applies if not using `Transfer-Encoding: chunked` or streaming."** Found 2026-10-01 the hard way: a 38 MiB video job's `Range: bytes=0-` (what a `<video>` sends first) came back 500 from the API itself, with the app logging a normal 206. Fix: `capRange` answers any range with at most 8 MiB (HTTP allows a shorter range than requested; players fetch the next piece), and a whole-file 200 over that size is sent chunked, without `content-length`. https://docs.cloud.google.com/run/quotas
- **Request body cap: "Maximum HTTP/1 request size: 32 MiB per request … No limit if using HTTP/2 server."** (verified 2026-10-01). Uploads go browser → web service → API service, both HTTP/1, and Next buffers the body in between, so the 25 MiB `MAX_UPLOAD_BYTES` (a project choice, not a quota) can be raised to at most ~31 MiB on this path. Anything larger (e.g. a 2-min 1080p mp4) needs the browser to upload straight to GCS with a V4 signed URL — **built 2026-10-01**: `getSignedUrl({version: "v4", action: "write", contentType, extensionHeaders: {"x-goog-content-length-range": "0,<max>"}})`. On Cloud Run there is no private key, so the client signs through IAM `signBlob` as the runtime SA, which needs `roles/iam.serviceAccountTokenCreator` **on itself** plus `iamcredentials.googleapis.com` enabled; the bucket needs CORS for the web origin with `PUT` and both signed headers. Measured locally: impersonating the SA from a user ADC fails with `Permission 'iam.serviceAccounts.signBlob' denied` unless the USER also holds Token Creator on the SA, so the signing path is verified on the deployed service, not on a laptop. https://docs.cloud.google.com/run/quotas · https://cloud.google.com/storage/docs/access-control/signing-urls-with-helpers

### Phase 5 — what the deploy would have got wrong, found before it did (2026-09-11)

- **Background work gets no CPU by default.** "With request-based billing, CPU is only allocated during request processing." https://docs.cloud.google.com/run/docs/configuring/billing-settings — and the pipeline runs *after* `POST /jobs` returns 202. SPEC's `min-instances=1` keeps the instance alive but does not give it CPU between polls. The API therefore deploys with `--no-cpu-throttling` (instance-based billing), which is the whole cost of the always-on API. Plus `--max-instances=1`: a job lives inside the process that accepted it, and a second instance is one Cloud Run can scale away mid-job.
- **Next.js 16 `proxy.ts` silently truncates request bodies above 10 MB.** Per `proxyClientMaxBodySize` in Next's bundled docs, the body is buffered only up to the limit and "the request will not fail". Measured locally against a production build with the limit left at default: a 26 MiB upload the API should refuse with 413 came back **500**, and Next logged `Request body exceeded 10MB for /api/v1/localize/jobs. Only the first 10MB will be available`. With `experimental.proxyClientMaxBodySize: "27mb"`: **413**. `npm run check:demo` pins it. Same failure shape as Phase 4's `@fastify/multipart` finding — a size cap that truncates instead of refusing — one layer further out.
- **Forwarding `/api/*` has to be runtime.** `rewrites()` in `next.config.ts` is evaluated at build time, so it could only forward to an address baked into the image. `web/src/proxy.ts` returns `NextResponse.rewrite(new URL(path, API_ORIGIN))` instead, per request, in dev and prod alike. Firebase Hosting in front of Cloud Run was not an option: it forwards only the cookie named `__session`, which would drop Better Auth's session cookie ("Only the specially-named `__session` cookie is permitted to pass through", https://firebase.google.com/docs/hosting/manage-cache).
- **`gcloud builds submit` uploads what `.gcloudignore` allows, not what `.dockerignore` allows.** The source tarball is stored in the project's `_cloudbuild` bucket; without a `.gcloudignore` that excludes `.env*`, `.env.development` (holding the Gemini key) would have been uploaded there even though no image ever contained it. Both `.gcloudignore` files exist for that line.
- **The setup wizard's 30-day bucket lifecycle rule would delete the demo's audio mid-judging** (5 Oct – 6 Nov). The production bucket is created by `deploy.sh` with no rule; `setup.sh` now warns.

### Phase 5 — measured on the deployed stack (2026-09-11)

`node src/scripts/e2e-localize.ts --base=<web> --origin=<web>` on `fixtures/sample_60s.mp3`, through the live web origin → `web/src/proxy.ts` → API → Cloud SQL, GCS, Gemini, Chirp 3 HD. asia-south1.

| Item | Measured value |
|---|---|
| **Upload → done** | **229.9 s**: analyze 83.0 s · brief + adapt (7 segments) 128.8 s · critique 6.5 s · synthesize 6.3 s. Inside Phase 4's localhost range (215.8–237.9 s), so Cloud Run + Cloud SQL + GCS + the extra proxy hop add nothing measurable at 2 s poll granularity. The pipeline got CPU between polls: `--no-cpu-throttling` is doing its job |
| Output | 10 model calls, 29,095 in / 7,443 out / 43,407 thinking; fidelity 95, naturalness 91, 0 retried; 9/15 emphasis claims energy-backed; 70.1 s Hindi for a 63.0 s span (+11%), 1,336 billed chars; Range 206 through the proxy; 109 polls, all schema-valid |
| **`TRUST_PROXY` = 2, measured** | Compared the web service's Cloud Run request log (`httpRequest.remoteIp`, the caller's real IP) with Fastify's logged `req.remoteAddress` for the same request. At **1**, Fastify saw `34.96.40.141` — the web service's egress IP — for every caller, i.e. one shared rate-limit key for the whole internet (300 req / 15 min; one 4-minute job's polling is ~120). At **2**, Fastify saw the caller's real IP, matching the web log exactly. The web egress IP also changed between the two measurements (`.141` → `.185`), so a hop count, not a proxy address, is the right form of the setting |
| **`/healthz` is unreachable from outside Cloud Run** | The front end answers it with Google's own 404 page before the container sees the request: "Some paths ending with `z`. To prevent conflicts with reserved paths, we recommend avoiding all paths that end in `z`" (https://docs.cloud.google.com/run/docs/known-issues). In-container probes bypass the front end, so the route stays; `deploy.sh`'s external smoke uses `/` |
| `sql-component.googleapis.com` | Required by `gcloud run jobs deploy --set-cloudsql-instances` in addition to `sqladmin`. Missing, gcloud prompts; `--quiet` answers the prompt "no" and reports `Aborted by user` — the first deploy's failure |
| Cloud Build | Web image 2 m 48 s. The builder is the classic Docker builder (`Removing intermediate container …`), so every Dockerfile stage is built, not just `runtime` |
| Signed-out check (`check-demo.ts`) | `/demo` 200 · demo Job parses, `done` · Range 206 on source and output · 26 MiB upload through the live proxy → **413** |


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

Node v24.14.0. `ffmpeg` and `gcloud` installed (Phase 5 deployed from this machine); `firebase` not used.
