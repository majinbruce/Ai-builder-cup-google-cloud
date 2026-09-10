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

---

## Phase 2 — Adapt + blind critique with auditable rationale

**"Your architecture diagram is Gemini calling Gemini and then Gemini grading
Gemini. The 'independent fidelity score' is the same model marking its own
homework, and the 'auditable rationale' is the model writing its own defence
statement. Strip out the vocabulary and what is left that a judge should count
as meaningful use of Gen AI, rather than one model call wearing three hats?"**

Three things, and the first is that the project does not make the claim being
attacked. Nothing here calls the critique independent: `critique.stage.ts` opens
by saying it is the same model family scoring output it produced, the CLI prints
that sentence above its own summary, and SPEC §b says it in the spec itself.
What is claimed is narrower and is a property of the code rather than of the
prompt — the critic is *blind*. `buildCritiqueInput()` builds the critic's entire
payload out of four things: the source English, the pedagogical signal label, the
terms the **speaker** stressed, and the Hindi. The rationale, the brief, the
glossary, `literalText`, the TTS hints and even the adapter's own `emphasisTerms`
list are not withheld by instruction, they are unreachable from the value that
function returns, and `test/adapt.test.ts` seeds every one of those fields with a
unique sentinel and asserts none of them appears anywhere in the serialized
payload. That last exclusion is the one worth pointing at: `emphasisPreserved`
asks whether the stressed terms survived, so handing the critic the adapter's own
claim about which Hindi tokens carry the stress would be asking it to check an
assertion against itself. It gets the English terms and has to find them. A
prompt that says "ignore the rationale" is a promise; a function that never puts
the rationale in the request is a mechanism, and only one of those survives a
future contributor adding a field. The second thing is that the blind pass
demonstrably catches something. On a run with the threshold raised to exercise
the path, the critic scored s04 at naturalness 78 and quoted the exact substring
`"इस बात की कहीं ज़्यादा भरपाई कर सकता है कि"` as a calque of the English "make
up for the fact that" — and the retry restructured precisely that clause into a
फ़ायदा/नुक़सान contrast while leaving the rest of the segment alone. Two
independent critique runs, at different thinking levels, both flagged the same
segment and both quoted the same substring, which is the difference between a
scorer with a rubric and a random number with a decimal point. The third is that
the "one model wearing three hats" framing describes a pipeline this deliberately
is not: the adapter never sees the critique's rubric, the critic never sees the
adapter's reasoning, and the brief is written before any segment exists so the
glossary cannot be rationalized backwards from what got produced. Gen AI is
load-bearing at every one of those stages — the pedagogical re-teaching, the
per-choice justification, the back-translation and the two-axis scoring are all
things nothing else in the system can produce — but the *architecture* around
them is what makes their output checkable, and that architecture is ordinary
typed code with tests.

**"Then why should anyone believe the two scores are measuring different
things, rather than one judgment reported twice?"** Because on the fixture they
come apart, and they come apart in the direction the design predicted. Fidelity
across the eight segments sits at 92-96 while naturalness ranges 82-95, and the
segment that separates them most (s04: fidelity 92, naturalness 82) is exactly
the one carrying an English relative-clause calque — faithful, and stiff. That is
the failure mode SPEC §g's risk table names for Hindi output and the reason
naturalness exists as a second axis rather than as a component of the first; had
the two scores tracked each other, the honest report would have been that the
second axis is decorative. It also survives its own strictest rule: the prompt
requires that any naturalness score below 90 carry a **verbatim quote** from the
Hindi, so a low score with no quotable evidence is not expressible.

**The parts of this phase that cost us something, recorded because they are the
parts a judge should press on.** First, the phase misses the demo budget and the
number is in `research.md` rather than rounded off: adapt is 110.0 s for eight
segments, stages 2-3 are 138.5 s, and a full run with Phase 1's analyze call is
~205 s against SPEC §g's 120 s target. One call per segment is what bought the
sequential context, the shallow schemas and the cheap retry, and it is also what
blew the budget; the lever is chosen but not yet pulled on the stage that would
actually pay for it, because `low` on adapt has to be judged on the Hindi and has
not been. Second, `thinking_level` was decided with numbers rather than taste —
`low` on critique gives **0** thought tokens and 7.7 s instead of 14.9 s, with
every score within 3 points and the same translationese quote on the same
segment — but that decision was only defensible because the comparison was made
on the artifact, per Phase 1's finding that its fastest run was also its worst.
Third, the retry gate fires on **0 of 8** segments at the real threshold of 70,
so the loop's demonstration required deliberately raising the threshold, and this
file says so rather than letting a passing run imply the path was exercised.
Fourth and most importantly, the length-drift result is an **estimate and is
labelled as one in the schema comment, the CLI output, the research note and
here**: −2% overall on the fixture is computed by dividing a character count by an
assumed 13 Devanagari characters per second, and the honest number cannot exist
until Phase 3 synthesizes real audio and divides its measured duration by the
characters that produced it. It settles SPEC §g's open drift risk well enough
that Phase 3 need not compress `speaking_rate`, and it is not a measurement, and
conflating those two would be exactly the sort of third fabricated metric that
Phase 1 spent its own credibility avoiding. The one number in this phase produced
by nothing but arithmetic and a regex — 0 of 8 segments containing Latin script
in the string bound for a Hindi TTS voice — is the only one here that owes the
model nothing at all.

---

## Phase 3 — Synthesis with prosody

**"Stage 4 is an HTTP call to a Google TTS product with a rate parameter on it.
Google's own dubbing does that. Where is the meaningful use of Gen AI here — and
isn't the 'preserved prosody' just a number the model made up, rendered by a
service that would have said the words anyway?"**

The second half of that question is the sharp half, and the honest answer is that
Phase 3 spent most of its effort finding out that the answer was nearly *no*, then
fixing it. Stage 4 itself claims no Gen AI: it is a typed request builder, and the
generative work it renders was done in stages 1–3. What it does claim is that the
rendering is *faithful to* those stages and *checkable* — and the first version
was neither, which is the part worth reporting. SPEC §b left synthesis conditional
on a spike ("SSML prosody **if** the Phase 3 spike confirms Chirp 3 HD honors it")
because three Google pages gave three different answers. The spike ran, tested a
predicted magnitude rather than a direction — `<break time="3s"/>` must add three
seconds — measured +3.71 s, and concluded SSML was honoured. Stage 4 was built on
that: every emphasis term stage 2 detected got wrapped in `<prosody rate="0.85">`.
The result was audio **41.3% longer** than its source span. Two 350 ms breaks and
sixteen rate wrappers cannot cost twenty-four seconds, so that number was not
drift, it was the bug reporting itself. The control that found it was a *no-op*:
`<prosody rate="1.0">` asks for the rate the voice already uses and must therefore
change nothing, and it moved the duration +12.8% — as much as `rate="slow"` did.
Two wrappers cost 1.69× one. So Chirp 3 HD parses SSML structure and ignores
inline `<prosody>`'s rate attribute, inserting ~1.4 s of dead air at each tag
instead; `<break>` "worked" only because inserting time is what `<break>` means,
so for that one tag the artifact and the intent coincide. **A prediction test tells
you a parser exists; a no-op test tells you what it parses.** The spike had the
first and needed both, and it now ships all four controls — noise floor, bogus
tag, predicted magnitude, no-op — so the corrected verdict is reproducible rather
than remembered. The consequence is stated in the schema rather than buried: the
field is `emphasisPausedTerm`, not `emphasisStressedTerm`, because what survived
measurement is a 150 ms pause before one term per segment — the beat a teacher
puts in front of a word they want to land — and per-term *stress* is not
achievable on this voice at all. Terms that get nothing acoustically are listed in
`emphasisNotRealized` and still highlighted in the panel, so the UI cannot show
emphasis the audio never applied.

**"Then what part of the pedagogical signal actually survives into audio, as
opposed to into a JSON field?"** Three things, each traceable to a stage-1 or
stage-2 decision and each measured on this voice: the segment's `speakingRate`
(rate 0.85 → +17.2%, real), the `pauseBefore` that stage 1 detects ahead of
definitions and warnings (`<break time="350ms"/>` → +0.30 s measured for 0.35 s
requested, accurate), and one pre-term pause per segment. That is a genuinely
smaller claim than "we reproduce the teacher's prosody", and it is the size of
claim the measurements support. It is also worth saying what this bought that a
literal dub does not have: the audio is *conditioned on the instructional label*
— a segment marked `warning` is slower and preceded by silence because stage 1
heard it as a warning, not because a fixed rule slowed every sentence.

**"You also claimed in Phase 2 that the length-drift risk was solved. Was it?"**
Yes, and Phase 3 is the first pass that can say so with a measurement instead of
arithmetic. Phase 2 divided a character count by an assumed 13 Devanagari
chars/sec, labelled it an estimate in four places, and committed to replacing it
the moment real audio existed. Measured plain-text rate on
`hi-IN-Chirp3-HD-Kore`: **12.72** chars/sec — the guess was 2% high, and
`drift.ts` now exports `MEASURED_CHARS_PER_SEC` with a unit test pinning it to
this file. On the fixture the adapted Hindi as plain text runs **+1.2%** against
its source span, so the character budget in `adapt.v1.md` does the job and SPEC
§g's assumed 15–25% overrun does not materialise. The total measured output is
**+11.6%**, which means **+10.2% is time stage 4 adds on purpose** — eight
emphasis pauses and two lead pauses, about 6.4 s, and the arithmetic closes.
Separating those two required synthesizing every segment a second time as plain
text (`--baseline`), and that control is not optional decoration: "our output is
41% too long" and "our output is 11% too long, of which 10 points are pauses we
chose to insert" are different claims, and only one of them is honest. The first
version of this phase would have reported the first one.

**What this phase costs and what it still cannot do.** Stage 4 is ~16 s of a
**180.4 s** cold end-to-end run on a 63 s clip, against SPEC §g's 120 s demo
target — so the budget miss Phase 2 confirmed is now larger, and the number is
published rather than rounded. Synthesis calls are genuinely independent, unlike
adapt's, so parallelizing them is the obvious Phase 4 lever; it was deliberately
not pulled here, because changing concurrency in the same commit that first
measures a stage makes the per-segment number unreadable. Cost is 1,372 billed
characters for the clip, and stage 4 emits **no** `ModelCall` even though SPEC's
enum has a `synthesize` member: Cloud TTS has no tokens, `lib/gemini.ts` already
treats missing usage as an error rather than a zero, and three confident zeros in
a cost panel would be worse than an absent row. Two things remain outside what
this phase can assert. `research.md` now records that `[pause short]` markup
produces **no measurable silence** in the leading position despite the Chirp 3 HD
docs listing it for `hi-IN` — a doc contradiction found by measurement and
corrected rather than worked around, per CLAUDE.md — but a duration measurement
cannot see a tag that changes only pitch or loudness, so "no measurable effect" is
not the same as "inert" and the file says so. And the one thing nothing in this
repository can settle: whether the Hindi *sounds* like a teacher. `output.mp3`
plays, the pauses land where `ttsHints` asked and ffprobe confirms it, and SPEC
§g's last risk row — a native Hindi speaker reviewing the fixture output before
the video is recorded — is still outstanding. It is listed as outstanding rather
than quietly satisfied by the fact that the file exists.

---

## Phase 4 — API module and web UI

**"Phase 4 is a job table, a polling endpoint and a React page. That is plumbing
every CRUD app has. Where is the meaningful use of Gen AI in it — and isn't the
'reasoning panel' just a nicer rendering of text the model wrote to justify
itself?"**

Phase 4 adds no model call, and that is the point of it: it is the phase where
twelve Gemini calls stop being JSON in a terminal and become something an
educator can audit, and it is built so that it cannot quietly turn into
post-hoc storytelling. The panel makes **zero** model calls. It renders only what
the pipeline already computed, so there is no "explain this choice" request
generating a justification after the fact. The rationale on screen was written
in the same call that wrote the Hindi. The critic's back-translation shown under
it came from a call that, by construction of `buildCritiqueInput()`, never saw
that rationale. The self-justification the question is worried about is exactly
what the layout is designed to expose. Every model claim sits beside something
the model did not write:
- the analyzer's "marked volume surge" on *more than make up*, beside ffmpeg's
  measured energy rise at 0:25.5, with a verdict tag. On the fixture run, 8 of 15
  emphasis claims were energy-backed, and the other 7 are on screen too, marked
  unsupported.
- the adapter's idiom choice, beside the literal translation it replaced.
- the adapter's confidence, beside the blind critic scoring that same segment's
  naturalness at 78 and quoting the calqued clause verbatim.
- the stressed Hindi terms, beside the exact SSML sent to Chirp 3 HD. Terms the
  voice did nothing for are labelled "not voiced".
- a regenerated segment, beside the note that its scores belong to the draft it
  replaced. That is true, because the critique runs once, before the retry. The UI
  says so rather than letting old scores decorate new text.

The per-segment footer puts the cost of that reasoning (tokens, thinking,
latency, TTS characters) next to the reasoning itself, because the product's
claim is that the judgment is worth what it costs, and that is only arguable with
the bill visible. What the phase honestly does not fix is time: three real runs
through the API took **215.8–237.9 s** upload-to-done against a 120 s budget.
Analyze and adapt, where the thinking is, account for about 93% of it. The only
lever pulled here was the one that changes no model output: synthesis went from
~16 s to 6.1 s by running four TTS calls at once. Mitigating the wait is
product design, not a hidden number. Stage artifacts are written the moment each
stage ends, so the learner sees the segmented, labelled transcript 55–90 s in
while the Hindi is still being written, and the public `/demo` is a real job this
API ran, flagged afterwards, with its telemetry intact.
