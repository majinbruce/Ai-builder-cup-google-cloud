# Fixtures

`sample_60s.mp3` is the demo clip every `src/scripts/stage-*.ts` script defaults
to. Expected outputs from a known-good run are saved beside it
(`analysis.expected.json`, …) so a prompt regression is visible as a diff.

Those expected files are **regenerated, not committed** — `npm run stage:analyze`
writes `outputs/analysis.json`, and copying an accepted run to
`fixtures/analysis.expected.json` makes the next run diffable against it. They
are gitignored for the same reason the mp3 is: they contain a verbatim
transcript of the clip, and the rights question below is unresolved.
`test/analyze.test.ts` skips its schema check when the file is absent, so a
fresh clone still passes.

Requirements for a good fixture: at least one definition, one stressed key term,
one warning, one idiom or cultural reference, and a recap. See `docs/SPEC.md` §c.
Real human speech, not TTS — synthesized audio has no genuine prosody, so
emphasis detection would be scoring a flat read.

## How the current clip was produced

Extracted from a source video with:

```bash
ffmpeg -i <source>.mp4 -vn -ac 1 -ar 16000 \
  -af loudnorm=I=-16:TP=-1.5:LRA=11 -c:a libmp3lame -b:a 64k \
  fixtures/sample_60s.mp3
```

63.1 s, 16 kHz mono, 494 KB. The `loudnorm` pass is not cosmetic: the source
averaged −45 dB with a −28 dB peak, quiet enough that a fixed-threshold
`silencedetect` found pauses everywhere. EBU R128 normalization preserves
*relative* dynamics, so emphasis detection is unaffected, while making the
absolute level sane. Lesson carried into Phase 1: the `silencedetect` threshold
must be computed relative to the clip's own mean, never hard-coded in dB.

## Rights — UNRESOLVED, do not publish until settled

**The current clip is third-party content, not team-owned.** Transcription of
its opening line and its subject matter (the brachistochrone problem) indicate
it is an excerpt from a published educational video. This repository is a
hackathon submission that becomes **public**, and the clip would also appear in
the demo video.

Until this is resolved the mp3 is deliberately **not committed** — see
`.gitignore`. Options, in order of preference:

1. Replace it with a clip the team recorded (someone reading a short technical
   explainer aloud, with genuine emphasis and pauses).
2. Use an openly licensed source (CC-BY) and record the licence and attribution
   here.
3. Keep it strictly local as a development fixture, ship the demo on
   team-recorded audio, and never commit or broadcast this file.

Whatever is chosen, this section must state the actual source and licence before
the repository is made public.
