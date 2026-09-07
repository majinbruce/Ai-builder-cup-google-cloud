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
 * Phase 0 defines only ModelCall, because lib/gemini.ts returns one from the
 * first call it makes. Analysis, Adaptation, Critique and Synthesis arrive with
 * their stages in Phases 1-3; see docs/SPEC.md section b for the full set.
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
