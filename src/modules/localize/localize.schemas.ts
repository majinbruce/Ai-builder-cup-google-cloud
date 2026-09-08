import { z } from "zod";

/**
 * Zod schemas for the localization pipeline.
 *
 * Each of these is used three times and defined once: converted with
 * z.toJSONSchema() into the Gemini `response_format.schema`, used to .parse()
 * the JSON that comes back, and used by Fastify as the response serializer.
 * That is what stops the model's contract, the database's contract and the
 * API's contract from drifting apart — there is only one of them.
 *
 * ModelCall came first, because lib/gemini.ts returns one from the very first
 * call this project makes. Analysis and the acoustic types arrived with stage 1;
 * Adaptation, Critique and Synthesis arrive with Phases 2-3. See docs/SPEC.md
 * section b for the full set.
 */

/**
 * Which pipeline stage a model call belongs to.
 *
 * `smoke` is not a pipeline stage — it is the Phase 0 connectivity check. It
 * lives in the same enum so that the telemetry path the real stages use is the
 * one exercised from the very first call, rather than a parallel code path that
 * is only proven later.
 */
export const ModelCallStage = z.enum([
  "smoke",
  "analyze",
  "adapt",
  "critique",
  "adapt_retry",
  "synthesize",
]);

/**
 * What one model call cost, recorded per job.
 *
 * This is telemetry with a purpose beyond ops: the product's claim is that the
 * reasoning it shows is worth what it costs, and the reasoning panel puts these
 * numbers on screen next to the reasoning they paid for.
 */
export const ModelCall = z.object({
  stage: ModelCallStage,
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  // Thinking tokens are billed as output but reported separately, so a stage
  // that is expensive because it thinks hard is distinguishable from one that
  // is expensive because it writes a lot.
  thoughtTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
});

export type ModelCall = z.infer<typeof ModelCall>;
export type ModelCallStage = z.infer<typeof ModelCallStage>;

/**
 * ============================================================================
 * Stage 1 — Analyze
 * ============================================================================
 *
 * Everything from here to AcousticEvidence is docs/SPEC.md section b, verbatim.
 * The comments explain what the model is being asked for and why; the
 * definitions themselves are the contract and must not drift from the spec.
 */

/**
 * The pedagogical signal taxonomy — docs/SPEC.md section c.
 *
 * This enum IS the differentiator. Every other localization pipeline produces a
 * transcript; this one produces a transcript where each span carries the
 * instructional role the teacher was performing, and everything downstream
 * (pacing, emphasis, the fidelity check) is conditioned on the label. It is a
 * closed enum rather than free text precisely so that "did the definition
 * survive as a definition" is a computable question.
 */
export const PedagogicalSignal = z.enum([
  "definition",
  "key_term",
  "example",
  "warning",
  "emphasis_shift",
  "transition",
  "recap",
  "none",
]);

/** The speaker's emotional colour for a span. Matched, never invented. */
export const Register = z.enum([
  "neutral",
  "enthusiastic",
  "cautionary",
  "reassuring",
  "humorous",
  "urgent",
]);

/** Relative delivery speed, which becomes a Chirp 3 HD `speaking_rate`. */
export const Pace = z.enum(["slow", "normal", "fast"]);

/**
 * A term the speaker stressed.
 *
 * `evidence` is required and is the field the acoustic corroboration check
 * reads against: the model has to say WHY it thinks a term was stressed, in
 * words, and then measurement either backs that up or does not. A bare
 * `{ term, strength }` pair would be an assertion with nothing to check.
 */
export const EmphasisMarker = z.object({
  term: z.string(),
  strength: z.enum(["moderate", "strong"]),
  evidence: z.string(),
});

/**
 * Something that cannot be translated word for word without losing its point.
 *
 * Both meanings are captured because the reasoning panel shows the learner the
 * gap: this is what it literally says, this is what it was FOR, and here is
 * what we said in Hindi to do the same job.
 */
export const IdiomOrReference = z.object({
  phrase: z.string(),
  literalMeaning: z.string(),
  intendedMeaning: z.string(),
  kind: z.enum(["idiom", "cultural_reference", "humor"]),
});

/** One pedagogically bounded span of the source audio, fully annotated. */
export const AnalyzedSegment = z.object({
  id: z.string(),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  text: z.string(),
  signal: PedagogicalSignal,
  signalConfidence: z.number().min(0).max(1),
  signalEvidence: z.string(),
  register: Register,
  pace: Pace,
  emphasis: z.array(EmphasisMarker),
  idioms: z.array(IdiomOrReference),
  keyTerms: z.array(z.string()),
});

/** The stage 1 artifact: what was taught, to whom, and how it was delivered. */
export const Analysis = z.object({
  sourceLanguage: z.string(),
  topic: z.string(),
  audience: z.string(),
  segments: z.array(AnalyzedSegment).min(1),
});

/**
 * ============================================================================
 * Measurement — ours, never the model's
 * ============================================================================
 *
 * AcousticEvidence and Corroboration are produced by ffmpeg and by arithmetic.
 * They are Zod schemas for the same reason the model's outputs are — they get
 * serialized into the job row and onto the API — but they are never converted
 * into a `response_format` and the model is never asked to fill them in. That
 * separation is the whole point: if the model could write these numbers, they
 * would corroborate nothing.
 */

/** A silent stretch measured by ffmpeg `silencedetect`. */
export const MeasuredPause = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  durationSec: z.number().positive(),
});

/** One window of the RMS energy series, flagged if it stands out. */
export const EnergyWindow = z.object({
  startSec: z.number().nonnegative(),
  rmsDb: z.number(),
  /** At or above the clip median + PROMINENCE_DB. */
  prominent: z.boolean(),
});

/**
 * What ffmpeg measured about a clip, and how it decided to measure it.
 *
 * `silenceThresholdDb` and `thresholdOffsetDb` are in the artifact deliberately.
 * The threshold is adaptive, so a reader who wants to reproduce a pause list
 * needs the value that produced it; a number that only exists inside the
 * function that chose it is not auditable evidence, it is a magic constant with
 * extra steps.
 */
export const AcousticEvidence = z.object({
  durationSec: z.number().positive(),
  meanVolumeDb: z.number(),
  silenceThresholdDb: z.number(),
  thresholdOffsetDb: z.number(),
  windowSec: z.number().positive(),
  medianRmsDb: z.number(),
  prominenceThresholdDb: z.number(),
  pauses: z.array(MeasuredPause),
  windows: z.array(EnergyWindow),
});

/**
 * Whether measurement backs up one of the model's emphasis claims.
 *
 * `not_measurable` exists so that a miss is never silently counted as a hit or
 * a failure: segment spans shorter than one energy window carry no evidence
 * either way, and saying so is more honest than rounding it to one of the other
 * two.
 */
export const EmphasisVerdict = z.enum(["supported", "unsupported", "not_measurable"]);

export const EmphasisCheck = z.object({
  segmentId: z.string(),
  term: z.string(),
  strength: z.enum(["moderate", "strong"]),
  modelEvidence: z.string(),
  verdict: EmphasisVerdict,
  /** What the measurement actually showed, in one line, for the audit panel. */
  measurement: z.string(),
});

/**
 * The model's claims scored against the measurements, per run.
 *
 * This never gates a run (see the plan and docs/JUDGE_NOTES.md): a corroboration
 * rate that fails the build is a rate under pressure to look good. It is
 * reported as it is, misses included.
 */
export const Corroboration = z.object({
  emphasisChecks: z.array(EmphasisCheck),
  supported: z.number().int().nonnegative(),
  /**
   * The subset of `supported` backed by a measured energy rise.
   *
   * Split out on 2026-09-08 after the first real run, because the combined
   * number was not honest evidence. A claim also scores `supported` when a
   * pause merely closes its span — but `analyze.v1.md` instructs the model to
   * place segment boundaries at the measured pauses, so that branch partly
   * rewards the model for following an instruction rather than for hearing
   * anything. Energy corroboration carries no such circularity: nothing tells
   * the model where the loud windows are except the audio and the measurement
   * block, and it has to put a claim inside one.
   *
   * Report both. `supportedByEnergy` is the number that survives a judge.
   */
  supportedByEnergy: z.number().int().nonnegative(),
  /** The circular-risk subset: supported only by a pause closing the span. */
  supportedByPauseOnly: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  notMeasurable: z.number().int().nonnegative(),
  /**
   * INTERIOR segment boundaries landing within BOUNDARY_TOLERANCE_SEC of a
   * real pause. Interior is the operative word: the clip's own start and end
   * are not choices the model made and can never align with a mid-clip pause,
   * so counting them only dilutes the rate. Shared boundaries between adjacent
   * segments are counted once, not twice.
   */
  boundariesAligned: z.number().int().nonnegative(),
  boundariesTotal: z.number().int().nonnegative(),
});

export type PedagogicalSignal = z.infer<typeof PedagogicalSignal>;
export type Register = z.infer<typeof Register>;
export type Pace = z.infer<typeof Pace>;
export type EmphasisMarker = z.infer<typeof EmphasisMarker>;
export type IdiomOrReference = z.infer<typeof IdiomOrReference>;
export type AnalyzedSegment = z.infer<typeof AnalyzedSegment>;
export type Analysis = z.infer<typeof Analysis>;
export type MeasuredPause = z.infer<typeof MeasuredPause>;
export type EnergyWindow = z.infer<typeof EnergyWindow>;
export type AcousticEvidence = z.infer<typeof AcousticEvidence>;
export type EmphasisVerdict = z.infer<typeof EmphasisVerdict>;
export type EmphasisCheck = z.infer<typeof EmphasisCheck>;
export type Corroboration = z.infer<typeof Corroboration>;
