# Fixtures

Put the demo clip here as `sample_60s.mp3` (60–90 s, English, educational, 16 kHz
mono is ideal but any mp3/wav works; ffmpeg normalizes on ingest).

Requirements for a good fixture: at least one definition, one stressed key term,
one warning, one idiom or cultural reference, and a recap. See `docs/SPEC.md` §c.

Every `src/scripts/stage-*.ts` script defaults to this file. Expected outputs from a
known-good run are saved beside it (`analysis.expected.json`, …) so a prompt
regression is visible as a diff.

Committed on purpose (< 10 MB). Rights: owned by the team.
