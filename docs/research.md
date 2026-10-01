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
  (`CALL_TIMEOUT_MS`), so a hung call fails its job in at most ~13 min instead
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
