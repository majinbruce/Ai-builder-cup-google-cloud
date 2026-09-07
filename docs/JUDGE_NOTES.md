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
Phase 0 establishes is that the model's output is a *contract*: one Zod schema
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
which the model could also have inferred from the *semantics* of the passage
without hearing a single change in pitch or volume. Phase 0 cannot distinguish
those two possibilities, and it would be dishonest to present it as though it
could. That ambiguity is exactly why measured acoustic evidence (ffmpeg
`silencedetect` for pause boundaries, `astats` for per-window energy) was moved
out of the fallback list and into Phase 1 as core: when the model says a term was
stressed, the pipeline will be able to show whether a real energy rise and a real
pause were there, or whether the model was pattern-matching on meaning. A judge
who pushes on "how do you know it actually heard the emphasis?" should get a
measurement in reply, not a claim.
