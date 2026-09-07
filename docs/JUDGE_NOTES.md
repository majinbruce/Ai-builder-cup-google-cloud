# Judge notes

Self-grilling, one entry per phase. The question at the top of each section is
the hardest one a judge could reasonably ask about that phase's work, and the
answer is written after the code ran, against the real output — not against what
the phase was hoping to produce.

Judging weights, for reference: Technical merit & Gen AI implementation 40%,
Problem alignment & impact 25%, Innovation 25%, UX 10%.

---

## Phase 0 — Scaffold, config, one Gemini call

**"You uploaded a file to an API and got JSON back. Where is the meaningful use
of Gen AI in that?"**

Nowhere, and Phase 0 does not claim otherwise — it earns zero of the 40% by
itself. What it does is settle, with evidence rather than assumption, the one
premise the other 40% is built on: that the model can be given raw audio and
made to answer in a shape the system can compute over. The run on
`fixtures/sample_60s.mp3` reports `input_tokens_by_modality: [{audio: 1576},
{text: 349}]`, which is the part that matters — the model was not handed a
transcript produced by some other tool and asked to reason about text. It
received 63 seconds of speech, and the fields it returned (a verbatim first
sentence, a topic identification of the brachistochrone problem) are ones it
could not have filled from the prompt alone. That is the difference between a
pipeline where Gen AI is load-bearing and one where it is a text-processing step
bolted to the end of a conventional speech-to-text stack, and it is worth
proving on day one rather than assuming until week three. The second thing
Phase 0 establishes is that the model's output is a _contract_: one Zod schema
per stage is converted to JSON Schema for the model, parses the reply, and later
serializes the API response, so a stage cannot silently return a shape the next
stage does not expect. Cost and latency come back from the same call
(1,925 in / 151 out / 208 thinking, 10.4 s) because the product's central claim
is that its visible reasoning is worth what it costs, and that is not arguable
without the numbers.

**The honest caveat, recorded now rather than discovered later.** The smoke
prompt deliberately included a field asking what was notable about the speaker's
delivery, because the entire differentiator rests on prosody being audible to
the model. It came back with emphasis on "shortest" versus "fastest" and
"rhythmic pauses designed to prompt listener reflection" — which reads well, and
which the model could also have inferred from the _semantics_ of the passage
without hearing a single change in pitch or volume. Phase 0 cannot distinguish
those two possibilities, and it would be dishonest to present it as though it
could. That ambiguity is exactly why measured acoustic evidence (ffmpeg
`silencedetect` for pause boundaries, `astats` for per-window energy) was moved
out of the fallback list and into Phase 1 as core: when the model says a term was
stressed, the pipeline will be able to show whether a real energy rise and a real
pause were there, or whether the model was pattern-matching on meaning. A judge
who pushes on "how do you know it actually heard the emphasis?" should get a
measurement in reply, not a claim.

---

## Phase 1 — Analyze: pedagogical segmentation with measured acoustic evidence

**"Your pitch is that you detect how the teacher _delivered_ the material. But
the model is a language model reading a transcript it produced itself. How do
you know it heard emphasis, rather than inferring it from the meaning of the
sentence — and if you can't tell, isn't the whole differentiator just a
confident-sounding model?"**

This is the question Phase 0 ended on and Phase 1 is the answer to, so the
answer is a mechanism rather than a reassurance. Every clip is measured by
ffmpeg before the model ever sees it: `volumedetect` for the clip's mean level,
`silencedetect` at a threshold derived from that mean for pause boundaries, and
windowed `astats` for a 0.5 s RMS energy series. On `fixtures/sample_60s.mp3`
that is 9 measured pauses and 127 energy windows, 5 of them at or above median +
3 dB — real numbers, produced by signal processing, with no model in the loop.
Those measurements are then used twice, and the fact that they are the _same_
numbers both times is the load-bearing part. They go into the analyze prompt, so
the model reasons about delivery with the pause and level structure in front of
it instead of guessing at it. And they are held back for `corroborate.ts`, which
scores every emphasis claim the model makes against them and reports, per claim,
whether measurement supports it — with the model's stated evidence ("louder and
slower than the surrounding clause") printed directly above what was actually
measured. So the answer to "how do you know" is a rate, computed by something
that is not the model, printed on every run including its misses. The threshold
that produces it is itself in the artifact (`silenceThresholdDb`,
`thresholdOffsetDb`), because it is adaptive and a number nobody can reproduce
is not evidence. That adaptivity is not incidental: a fixed −33 dB threshold
finds **zero** pauses on this clip while mean − 6 dB finds nine, so a hard-coded
constant would have produced a plausible-looking pipeline that silently measured
nothing. Gen AI is load-bearing here rather than decorative — the eight-label
pedagogical taxonomy, the segmentation at instructional boundaries, the idiom
detection and the transcript are all things only the model can produce, and
nothing downstream works without them — but the one claim it makes that could
not otherwise be checked is the one we built a second, independent measurement
to check.

**Three things this deliberately does not claim.** First, the granularity is the
segment, not the word: stage 1 returns 4–12 s spans and nothing gives us the
timestamp of an individual term, so `supported` means "this span carries
acoustic evidence consistent with the claim", not "that word was measurably
louder". Word-level alignment via `gemini-3.5-transcribe` is the documented
escalation in SPEC §g and is not pretended at. Second, `unsupported` is not the
same as wrong — stress is carried by pitch and lengthening as much as by level,
and this pass measures level and silence, so the rate is a floor on
corroboration rather than a score for the model. That is exactly why it reports
and never fails the run: a number that can break a build is a number under
pressure to look good. Third, and most importantly for anyone reading this
before the demo: **as of this commit the corroboration rate on the fixture is
unmeasured, because the Gemini free tier cut the run off.** The 429 reports
`limit: 20` on `generate_content_free_tier_requests` and returns it unchanged
after seven minutes of idleness, so the binding cap is not the 5 RPM previously
recorded — it is a longer-window request cap that today's runs exhausted
(`docs/research.md` now says so). The measurement half of the stage runs and is
shown above; the model half is written, typechecked, schema-bound and covered by
82 passing unit tests, and has not yet produced a real analysis. Billing is
therefore a prerequisite for finishing Phase 1, not a submission-week checklist
item. This entry gets the actual numbers appended the moment a real run lands,
and if the corroboration rate comes back poor, that number goes here too.
(Correction, same day: billing was subsequently attached to the project, and
the 429 changed to `Your prepayment credits are depleted` — reproduced twice.
So the account is on prepaid billing at a zero balance rather than on the free
tier, and the blocker is funding, not rate. The AI Studio prepay balance has to
be topped up before any Gemini call in this repo succeeds.)
