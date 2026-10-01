import { z } from "zod";

/**
 * ============================================================================
 * The API's DTOs, restated on this side of the wire.
 * ============================================================================
 *
 * These mirror the API's per-module `*.schemas.ts` files in the API. The duplication is
 * deliberate and is the price of two independently deployed services: the
 * frontend and the API version separately, and a running frontend must be able
 * to say "that response is not the shape I was built against" rather than
 * render `undefined`.
 *
 * KEEP THEM IN SYNC. When a DTO changes in the API, change it here in the same
 * commit. `npm run typecheck` will not catch the drift — the parse at runtime
 * will, which is why every response goes through one.
 */
export const userRoleSchema = z.enum(["user", "admin"]);
export type UserRole = z.infer<typeof userRoleSchema>;

/** Mirrors `userDtoSchema` / `sessionUserDtoSchema` in the API. */
export const userSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  role: userRoleSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type User = z.infer<typeof userSchema>;

/** Mirrors `meDtoSchema` — the payload of `GET /api/auth/me`. */
export const meSchema = z.object({
  user: userSchema,
  session: z.object({
    id: z.uuid(),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  }),
});
export type Me = z.infer<typeof meSchema>;

/** Mirrors `authProvidersDtoSchema` — the payload of `GET /api/auth/providers`. */
export const authProvidersSchema = z.object({
  social: z.array(z.enum(["google"])),
  emailAndPassword: z.boolean(),
  requireEmailVerification: z.boolean(),
});
export type AuthProviders = z.infer<typeof authProvidersSchema>;

/**
 * ============================================================================
 * Localize — mirrors src/modules/localize/localize.schemas.ts in the API.
 * ============================================================================
 *
 * Field for field, including the comments' intent: `targetText` is the Hindi
 * that was spoken, `literalText` is the control the reasoning panel shows
 * beneath it, and the Synthesis block records what the audio actually did —
 * `emphasisNotRealized` exists so the panel can say which highlighted terms the
 * voice did nothing for.
 */
export const pedagogicalSignalSchema = z.enum([
  "definition",
  "key_term",
  "example",
  "warning",
  "emphasis_shift",
  "transition",
  "recap",
  "none",
]);
export type PedagogicalSignal = z.infer<typeof pedagogicalSignalSchema>;

export const modelCallSchema = z.object({
  stage: z.enum([
    "smoke",
    "analyze",
    "brief",
    "adapt",
    "critique",
    "adapt_retry",
    "synthesize",
  ]),
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  thoughtTokens: z.number().int(),
  latencyMs: z.number().int(),
});
export type ModelCall = z.infer<typeof modelCallSchema>;

export const analyzedSegmentSchema = z.object({
  id: z.string(),
  startSec: z.number(),
  endSec: z.number(),
  text: z.string(),
  signal: pedagogicalSignalSchema,
  signalConfidence: z.number(),
  signalEvidence: z.string(),
  register: z.enum([
    "neutral",
    "enthusiastic",
    "cautionary",
    "reassuring",
    "humorous",
    "urgent",
  ]),
  pace: z.enum(["slow", "normal", "fast"]),
  emphasis: z.array(
    z.object({
      term: z.string(),
      strength: z.enum(["moderate", "strong"]),
      evidence: z.string(),
    })
  ),
  idioms: z.array(
    z.object({
      phrase: z.string(),
      literalMeaning: z.string(),
      intendedMeaning: z.string(),
      kind: z.enum(["idiom", "cultural_reference", "humor"]),
    })
  ),
  keyTerms: z.array(z.string()),
});
export type AnalyzedSegment = z.infer<typeof analyzedSegmentSchema>;

export const analysisSchema = z.object({
  sourceLanguage: z.string(),
  topic: z.string(),
  audience: z.string(),
  segments: z.array(analyzedSegmentSchema),
});
export type Analysis = z.infer<typeof analysisSchema>;

export const emphasisCheckSchema = z.object({
  segmentId: z.string(),
  term: z.string(),
  strength: z.enum(["moderate", "strong"]),
  modelEvidence: z.string(),
  verdict: z.enum(["supported", "unsupported", "not_measurable"]),
  measurement: z.string(),
});
export type EmphasisCheck = z.infer<typeof emphasisCheckSchema>;

export const corroborationSchema = z.object({
  emphasisChecks: z.array(emphasisCheckSchema),
  supported: z.number().int(),
  supportedByEnergy: z.number().int(),
  supportedByPauseOnly: z.number().int(),
  unsupported: z.number().int(),
  notMeasurable: z.number().int(),
  boundariesAligned: z.number().int(),
  boundariesTotal: z.number().int(),
});
export type Corroboration = z.infer<typeof corroborationSchema>;

export const choiceKindSchema = z.enum([
  "idiom",
  "cultural_reference",
  "term_kept_english",
  "restructured",
  "added_clarifier",
  "register_shift",
]);
export type ChoiceKind = z.infer<typeof choiceKindSchema>;

export const adaptedSegmentSchema = z.object({
  id: z.string(),
  targetText: z.string(),
  literalText: z.string(),
  termsUsed: z.array(z.string()),
  rationale: z.string(),
  emphasisTerms: z.array(z.string()),
  choices: z.array(
    z.object({
      kind: choiceKindSchema,
      original: z.string(),
      adapted: z.string(),
      why: z.string(),
    })
  ),
  ttsHints: z.object({
    speakingRate: z.number(),
    pauseBefore: z.enum(["none", "short", "long"]),
    style: z.string(),
  }),
});
export type AdaptedSegment = z.infer<typeof adaptedSegmentSchema>;

export const adaptationSchema = z.object({
  targetLanguage: z.string(),
  brief: z.object({
    topic: z.string(),
    audience: z.string(),
    instructorPersona: z.string(),
    registerGuidance: z.string(),
    glossary: z.array(
      z.object({
        english: z.string(),
        decision: z.enum(["transliterate", "translate", "keep_english_concept"]),
        targetForm: z.string(),
        why: z.string(),
      })
    ),
  }),
  segments: z.array(adaptedSegmentSchema),
});
export type Adaptation = z.infer<typeof adaptationSchema>;

export const segmentCritiqueSchema = z.object({
  id: z.string(),
  backTranslation: z.string(),
  fidelity: z.number().int(),
  naturalness: z.number().int(),
  translationese: z.array(z.string()),
  signalPreserved: z.boolean(),
  emphasisPreserved: z.boolean(),
  issues: z.array(z.string()),
  suggestion: z.string().optional(),
});
export type SegmentCritique = z.infer<typeof segmentCritiqueSchema>;

export const critiqueSchema = z.object({
  overallFidelity: z.number().int(),
  overallNaturalness: z.number().int(),
  segments: z.array(segmentCritiqueSchema),
});
export type Critique = z.infer<typeof critiqueSchema>;

export const synthesizedSegmentSchema = z.object({
  id: z.string(),
  startSec: z.number(),
  endSec: z.number(),
  voice: z.string(),
  speakingRate: z.number(),
  markupUsed: z.string(),
  inputMode: z.enum(["text", "markup", "ssml"]),
  /** Absent when the segment was voiced inside a longer utterance (2026-10-01 on). */
  measuredDurationSec: z.number().optional(),
  billedChars: z.number().int().optional(),
  latencyMs: z.number().int().optional(),
  /** Index into `utterances`: the TTS call this segment was spoken in. */
  utterance: z.number().int().optional(),
  emphasisNotFound: z.array(z.string()),
  emphasisPausedTerm: z.string().nullable(),
  pauseBeforeMs: z.number().int(),
  emphasisNotRealized: z.array(z.string()),
});
export type SynthesizedSegment = z.infer<typeof synthesizedSegmentSchema>;

/**
 * One Cloud TTS call: consecutive segments spoken in one breath, placed on the
 * source timeline. Jobs from before 2026-10-01 have none.
 */
export const synthesizedUtteranceSchema = z.object({
  index: z.number().int(),
  segmentIds: z.array(z.string()),
  sourceStartSec: z.number(),
  deadlineSec: z.number(),
  markupUsed: z.string(),
  inputMode: z.enum(["text", "markup", "ssml"]),
  requestedRate: z.number(),
  speakingRate: z.number(),
  naturalDurationSec: z.number(),
  measuredDurationSec: z.number(),
  refit: z.boolean(),
  pauseBeforeMs: z.number().int(),
  outputStartSec: z.number(),
  billedChars: z.number().int(),
  latencyMs: z.number().int(),
});
export type SynthesizedUtterance = z.infer<typeof synthesizedUtteranceSchema>;

export const synthesisSchema = z.object({
  audioUri: z.string(),
  durationSec: z.number(),
  voice: z.string(),
  segments: z.array(synthesizedSegmentSchema),
  utterances: z.array(synthesizedUtteranceSchema).optional(),
  sourceDurationSec: z.number().optional(),
  billedChars: z.number().int(),
  measuredCharsPerSec: z.number(),
});
export type Synthesis = z.infer<typeof synthesisSchema>;

/** Mirrors the API's `UploadTarget`: where and how to PUT the file. */
export const uploadTargetSchema = z.object({
  uploadId: z.uuid(),
  url: z.string(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type UploadTarget = z.infer<typeof uploadTargetSchema>;

export const jobStatusSchema = z.enum([
  "queued",
  "ingesting",
  "analyzing",
  "adapting",
  "critiquing",
  "synthesizing",
  "done",
  "failed",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** Mirrors `Job` — the full job, polled by the progress view. */
export const jobSchema = z.object({
  id: z.uuid(),
  status: jobStatusSchema,
  targetLanguage: z.string(),
  sourceUri: z.string().nullable(),
  /**
   * Set when the upload had playable footage. Defaulted rather than required so
   * a page served by a newer web build against an older API still parses.
   */
  sourceVideoUri: z.string().nullable().default(null),
  /** The footage with the Hindi under it; null until done, or if the mux failed. */
  outputVideoUri: z.string().nullable().default(null),
  posterUri: z.string().nullable().default(null),
  sourceDurationSec: z.number().nullable().default(null),
  error: z.string().nullable(),
  analysis: analysisSchema.nullable(),
  corroboration: corroborationSchema.nullable(),
  adaptation: adaptationSchema.nullable(),
  critique: critiqueSchema.nullable(),
  retriedIds: z.array(z.string()).nullable(),
  synthesis: synthesisSchema.nullable(),
  calls: z.array(modelCallSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Job = z.infer<typeof jobSchema>;

/** Mirrors `JobSummary` — one row of the job list. */
export const jobSummarySchema = z.object({
  id: z.uuid(),
  status: jobStatusSchema,
  topic: z.string().nullable(),
  segmentCount: z.number().int().nullable(),
  // Defaulted like the Job's video fields, so a newer web build still parses an
  // older API's list.
  hasVideo: z.boolean().default(false),
  hasPoster: z.boolean().default(false),
  durationSec: z.number().nullable().default(null),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;
