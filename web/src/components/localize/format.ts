import type { ChoiceKind, JobStatus, PedagogicalSignal } from "@/lib/api/schemas";

/** Seconds as m:ss.s — segment boundaries are sub-second, so keep a decimal. */
export function formatTime(sec: number): string {
  const minutes = Math.floor(sec / 60);
  const seconds = (sec - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${seconds}`;
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
 * One colour per instructional move, so the segment list reads as the shape of
 * the lesson at a glance. Tailwind classes, light and dark; the designer owns
 * the final palette.
 */
export const SIGNAL_TONE: Record<PedagogicalSignal, string> = {
  definition: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  key_term: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  example: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  warning: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  emphasis_shift: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  transition: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  recap: "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200",
  none: "bg-muted text-muted-foreground",
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
    detail: "Chirp 3 HD, with the pacing and pauses stage 1 heard",
  },
  { status: "done", label: "Done", detail: "" },
];

export const stepIndex = (status: JobStatus): number =>
  PIPELINE_STEPS.findIndex((step) => step.status === status);
