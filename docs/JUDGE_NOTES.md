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
pressure to look good.

**The numbers, now measured (2026-09-08).** The blocker above was a funding one
— prepaid billing at a zero balance, not a rate limit — and it was resolved by
topping the balance up; the diagnosis held and no code changed. Five real runs
on the fixture since then: emphasis corroboration is **84–87%**, stable run to
run, and **8 of 9 signal labels are identical across independent runs** with
boundaries within 0.8 s, which is the answer to "isn't a non-deterministic
labeler just a coin flip". But the number this project actually cites is lower
and is the one below.

---

## Phase 1 (completed) — what the first real runs changed

**"You built the corroboration check yourself, you chose its thresholds, and you
report its result. Why is an 84% number that a system awards itself evidence of
anything?"**

Because the first thing it did when pointed at real output was cost us the 84%.
Corroboration marks a claim `supported` on either of two branches — an energy
rise measured inside the span, or a pause closing the span — and the analyze
prompt *instructs* the model to cut segments at the measured pauses. So the
second branch partly rewards the model for following an instruction rather than
for hearing anything, and pooling the two produced a headline that flattered
itself. Splitting them (`supportedByEnergy` vs `supportedByPauseOnly`) puts the
defensible figure at **53%**, not 84%, and the CLI now prints "read the energy
number, not the headline" above its own summary. The same pass found the
boundary metric counting each interior cut twice and including the clip's own
0.0 and duration — boundaries no model chose and none can align to — reporting a
real 4-of-8 as "8/18 (44%)". Both were reporting bugs that made the project look
better, both were invisible to 84 passing unit tests because synthetic fixtures
only ever exercise one branch at a time, and both are fixed. The strongest
evidence that the metric is not decorative, though, is the run where it went
*up*: one analyze call scored 83% boundary alignment and 100% emphasis support
in 15.7 s, and it was the worst output of the five — it had obeyed "cut at the
pauses" so literally that it split a list from the words introducing it and put
one definition's subject in one segment and its predicate in the next. Every
number improved while the thing stage 1 exists to produce was destroyed. That
run is why `analyze.v1.md` now says the instructional move wins over the pause,
why alignment fell back to 44% once the segmentation was correct again, and why
`docs/research.md` records "treat a rising alignment number as a warning sign,
not progress". A self-awarded score is worth something exactly when it is built
to be lost, read against the artifact rather than instead of it, and published
with its misses — which is the same standard the pipeline's critique stage will
be held to in Phase 2, and the reason that stage is blind to the rationale it
grades.

**The cost finding, recorded because it constrains the demo.** An analyze call
spends 18,000–20,600 thought tokens against ~2,200 output tokens and takes
63–70 s. Thinking is ~90% of generation and the dominant latency term, and it is
wildly variable on identical input — one run spent 1,864. Five sequential stages
of this shape cannot fit the two-minute demo budget, so SPEC §g's `thinking_level`
lever is now known to be necessary rather than optional. The catch is that the
1,864-token run was also the worst one, so latency bought with `low` has to be
judged on output, not on the clock.
