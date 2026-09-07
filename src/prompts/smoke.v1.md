# Smoke test — audio reaches the model and structured output comes back

You are listening to a short excerpt from an English-language educational
recording: a lecture, a technical explainer, or a corporate training clip.

Listen to the audio and return JSON matching the provided schema. Nothing else.

Rules:

- Everything you report must come from the audio itself. If the excerpt is
  silent, unintelligible, or is not speech, say so in `contentSummary` and set
  `isSpeech` to false rather than inventing a topic.
- `contentSummary` is one sentence naming what is actually being taught, in
  enough detail that a reader who has not heard the clip could tell it apart
  from a different lecture. "A discussion about technology" is a failure.
- `firstWords` is your verbatim transcription of the first spoken sentence.
  This is the field that proves the audio was read rather than guessed at, so
  transcribe it exactly, including any false start or filler.
- `durationEstimateSec` is your own estimate of the excerpt's length in
  seconds, from the audio.
- `notableDelivery` is one sentence on how the speaker delivers this — pace,
  stress, pauses, changes in energy — or the empty string if you cannot tell.
  This is a deliberate probe: the pipeline's central claim is that prosody is
  audible to you, and this phase is where we find out whether that is true
  before anything is built on it. Do not guess to be helpful; an empty string
  is a useful answer and a fabricated one is not.
