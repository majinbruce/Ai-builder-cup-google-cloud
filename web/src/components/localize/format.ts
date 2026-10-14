import type {
  ChoiceKind,
  JobStatus,
  PedagogicalSignal,
  SynthesizedUtterance,
} from "@/lib/api/schemas";

/** Seconds as m:ss.s — segment boundaries are sub-second, so keep a decimal. */
export function formatTime(sec: number): string {
  // Rounded to tenths BEFORE splitting, or 59.97 prints as "0:60.0".
  const rounded = Number(sec.toFixed(1));
  const minutes = Math.floor(rounded / 60);
  const seconds = (rounded - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${seconds}`;
}

/**
 * What was done to the kept take to fit it, in a sentence.
 *
 * The tempo is read off the two durations rather than `speakingRate`, which
 * for a Chirp take also carries the rate it was synthesized at.
 */
export function describeFit(utterance: SynthesizedUtterance): string {
  if (!utterance.refit) return "played as it was recorded";

  // Before 2026-10-06 a refit was a second, faster Cloud TTS take.
  if (utterance.engine === undefined) {
    return (
      `first take ${utterance.naturalDurationSec.toFixed(2)} s ran long; re-taken at ` +
      `rate ${utterance.requestedRate.toFixed(2)} → ${utterance.speakingRate.toFixed(2)}`
    );
  }

  const tempo = utterance.naturalDurationSec / utterance.measuredDurationSec;
  const from = `from ${utterance.naturalDurationSec.toFixed(2)} s`;
  return tempo > 1
    ? `sped up ×${tempo.toFixed(2)} ${from}, to end before the next line's cue`
    : `slowed ×${tempo.toFixed(2)} ${from}, to last while the teacher is speaking`;
}

/**
 * Every take of a line that was recorded more than once, with what using each
 * would have meant and which one is heard; null for a line recorded once.
 */
export function describeTakes(utterance: SynthesizedUtterance): string | null {
  const takes = utterance.takes ?? [];
  if (takes.length < 2) return null;

  return takes
    .map((take) => {
      const left =
        take.lateSec > 0
          ? `next line ${take.lateSec.toFixed(1)} s late`
          : `teacher unheard for ${take.silentSec.toFixed(1)} s`;
      return (
        `${take.pace} ${take.durationSec.toFixed(2)} s (${left})` +
        (take.kept ? " — kept" : "")
      );
    })
    .join("; ");
}

export const SIGNAL_LABEL: Record<PedagogicalSignal, string> = {
  definition: "Definition",
  key_term: "Key term",
  example: "Example",
  warning: "Warning",
  emphasis_shift: "This part matters",
  transition: "Transition",
  recap: "Recap",
  none: "No instructional role",
};

/**
 * One colour per instructional move, so a segment strip reads as the shape of
 * the lesson at a glance. The designer's five (Nua's palette) plus three for
 * the moves the demo lecture happened not to use.
 */
export const SIGNAL_COLOR: Record<PedagogicalSignal, string> = {
  definition: "#ffe56e",
  key_term: "#f2ac48",
  example: "#bfc26a",
  warning: "#f07f6a",
  emphasis_shift: "#cb4e39",
  transition: "#868a59",
  recap: "#fab0a1",
  none: "rgb(255 231 206 / 25%)",
};

/** One line per signal: what the teacher was doing, in a learner's terms. */
export const SIGNAL_MEANING: Record<PedagogicalSignal, string> = {
  definition: "States what something is",
  key_term: "Names a term the learner must remember",
  example: "Makes an idea concrete",
  warning: "Flags a common mistake",
  emphasis_shift: "Changes tone because this part matters",
  transition: "Moves the lesson to its next idea",
  recap: "Sums up what was covered",
  none: "No instructional role",
};

export const CHOICE_LABEL: Record<ChoiceKind, string> = {
  idiom: "Idiom adapted",
  cultural_reference: "Cultural reference",
  term_kept_english: "Term kept as English concept",
  restructured: "Restructured",
  added_clarifier: "Clarifier added",
  register_shift: "Register shift",
};

/** The pipeline, in order, as the progress view names it. */
export const PIPELINE_STEPS: { status: JobStatus; label: string; detail: string }[] = [
  { status: "queued", label: "Uploaded", detail: "Normalized to 16 kHz mono and stored" },
  {
    status: "analyzing",
    label: "Analyze",
    detail: "Gemini listens to the audio, with ffmpeg's pause and energy measurements",
  },
  {
    status: "adapting",
    label: "Adapt",
    detail: "A brief and glossary, then each segment re-taught in Hindi, in order",
  },
  {
    status: "critiquing",
    label: "Critique",
    detail: "Blind back-translation, scored for fidelity and naturalness",
  },
  {
    status: "synthesizing",
    label: "Synthesize",
    detail: "Gemini TTS, directed with the register, pace and stress stage 1 heard",
  },
  { status: "done", label: "Done", detail: "" },
];

export const stepIndex = (status: JobStatus): number =>
  PIPELINE_STEPS.findIndex((step) => step.status === status);
