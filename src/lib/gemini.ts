import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { config } from "../config/index.ts";
import type { ModelCall, ModelCallStage } from "../modules/localize/localize.schemas.ts";

/**
 * ============================================================================
 * The one place this project names a Gemini model or a Gemini API surface.
 * ============================================================================
 *
 * docs/SPEC.md section g lists "Gemini model or API surface renamed
 * mid-hackathon" as a live risk, and this module is the mitigation: every stage
 * calls generateJson(), so a rename is one constant and one deploy rather than
 * a search across five call sites during the last week.
 *
 * Two rules hold everywhere below, and they are the difference between a
 * pipeline and a pile of string handling:
 *
 *   1. Every call declares its response shape as a Zod schema, that schema is
 *      converted to JSON Schema for the model, and the reply is parsed with the
 *      same schema. There is no free-text parsing and no `as` cast anywhere in
 *      the pipeline.
 *   2. Every call returns its own cost. Telemetry is not bolted on later; it
 *      comes back from the first call this project ever makes.
 *
 * API surface verified against @google/genai 2.21.0 typings on 2026-09-07:
 * `interactions.create` takes `{ model, input, response_format }` flat (not
 * nested under `generation_config`), and returns `output_text` plus a `usage`
 * object. See docs/research.md.
 */

/** Verified 2026-09-07, docs/research.md. Overridable via GEMINI_MODEL. */
export const GEMINI_MODEL = config.gemini.model;

/**
 * Inline audio is capped by the total request size, not the file size, so this
 * sits below the documented 20 MB with room for the prompt and base64's 4/3
 * expansion. Larger inputs need the Files API — which the route-level 25 MB /
 * 180 s caps mean the product never actually reaches, so it is deliberately not
 * implemented rather than half-implemented.
 */
const MAX_INLINE_AUDIO_BYTES = 14 * 1024 * 1024;

/**
 * Exactly the audio MIME types Gemini documents, and nothing else.
 *
 * `.m4a` and `.webm` were here and are deliberately gone: neither audio/m4a nor
 * audio/webm appears in the documented set, so accepting them advertised
 * support this project had never verified. Nothing is lost — ingest normalizes
 * every upload to 16 kHz mono mp3 before a model call, so this map only ever
 * sees the CLI stage scripts pointed at a fixture. A contributor who needs one
 * of those formats should convert it, and the error below says so.
 */
const AUDIO_MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mp3",
  ".wav": "audio/wav",
  ".aiff": "audio/aiff",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

let client: GoogleGenAI | null = null;

/**
 * Lazily built so that importing this module — which app.ts does transitively —
 * never requires a key. A deploy with no GEMINI_API_KEY boots and serves every
 * non-pipeline route; it fails here, by name, the moment a stage actually runs.
 */
export function getGeminiClient(): GoogleGenAI {
  if (client) return client;

  const apiKey = config.gemini.apiKey;
  if (apiKey === null) {
    throw new Error(
      "GEMINI_API_KEY is not configured, so no pipeline stage can run. " +
        "Get a key from https://aistudio.google.com/apikey and set it in .env.development."
    );
  }

  client = new GoogleGenAI({ apiKey });
  return client;
}

/** A single piece of model input: prompt text, or audio. */
export type InputPart =
  { type: "text"; text: string } | { type: "audio"; data: string; mime_type: string };

/**
 * Reads an audio file into an inline base64 input part.
 *
 * Throws above the inline cap rather than silently truncating or falling back,
 * because a request that is one byte too large fails at the API with a message
 * about the request body, and the actual cause — this file — is three frames
 * away by then.
 */
export function audioPart(filePath: string): InputPart {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = AUDIO_MIME_TYPES[extension];

  if (mimeType === undefined) {
    throw new Error(
      `Unsupported audio extension "${extension}" for ${filePath}. ` +
        `Gemini accepts: ${Object.keys(AUDIO_MIME_TYPES).join(", ")}. ` +
        "Convert first: ffmpeg -i <in> -ar 16000 -ac 1 out.mp3"
    );
  }

  const bytes = fs.readFileSync(filePath);

  if (bytes.byteLength > MAX_INLINE_AUDIO_BYTES) {
    throw new Error(
      `${filePath} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB, above the ` +
        `${MAX_INLINE_AUDIO_BYTES / 1024 / 1024} MB inline request limit. ` +
        "Normalize it to 16 kHz mono mp3 first (ffmpeg, see lib/ffmpeg.ts)."
    );
  }

  return { type: "audio", data: bytes.toString("base64"), mime_type: mimeType };
}

/**
 * How hard the model thinks before answering.
 *
 * `"minimal"` is deliberately absent even though the SDK's union type lists it:
 * measured 2026-09-07, `gemini-3.8-flash` returns a 400 — `'minimal' is not a
 * supported thinking level for this model` (docs/research.md). Narrowing the
 * type here turns a runtime 400 into a compile error.
 *
 * Left unset, the model uses its default, which Phase 1 measured at 18,000-20,600
 * thought tokens for one analyze call — ~90% of generated tokens and the
 * dominant latency term. This is the lever docs/SPEC.md section g names for the
 * two-minute demo budget, and it is a per-stage decision: a stage whose job is
 * judgment should think, and a mechanical one should not have to.
 */
export type ThinkingLevel = "low" | "medium" | "high";

/** Anything with a `.debug()` — Fastify's logger, or a script's stand-in. */
export interface CallLogger {
  debug: (details: Record<string, unknown>, message: string) => void;
}

export interface GenerateJsonOptions<T extends z.ZodType> {
  /** The shape the model must return. Also parses the reply. */
  schema: T;
  /** Prompt text, loaded from src/prompts via loadPrompt(). */
  prompt: string;
  /** Audio or extra text parts appended after the prompt. */
  parts?: InputPart[];
  /** Which pipeline stage this call belongs to, for the telemetry row. */
  stage: ModelCallStage;
  /** Omit to leave the model at its default thinking budget. */
  thinkingLevel?: ThinkingLevel;
  logger?: CallLogger;
}

export interface GenerateJsonResult<T> {
  data: T;
  call: ModelCall;
  /** The untouched SDK response, for the Phase 0 smoke dump. */
  raw: unknown;
}

/**
 * One Gemini call, in, out, and costed.
 *
 * The Zod schema goes in three directions from here: to the model as the
 * enforced output shape, back over the reply as the parser, and (in later
 * phases) onward as the Fastify serializer. Hand-writing the JSON Schema
 * instead would create a second definition that drifts silently — the model
 * would keep returning what the hand-written schema asked for while the Zod
 * parse rejected it.
 */
export async function generateJson<T extends z.ZodType>(
  options: GenerateJsonOptions<T>
): Promise<GenerateJsonResult<z.infer<T>>> {
  const { schema, prompt, parts = [], stage, thinkingLevel, logger } = options;

  // `$schema` is a JSON Schema meta-annotation; Gemini's structured output
  // takes an OpenAPI-flavoured subset and has no use for it.
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema) as Record<
    string,
    unknown
  >;

  const input: InputPart[] = [{ type: "text", text: prompt }, ...parts];

  const startedAt = performance.now();

  const interaction = await getGeminiClient().interactions.create({
    model: GEMINI_MODEL,
    input,
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: jsonSchema,
    },
    // Spread rather than passed as an explicit undefined: exactOptionalPropertyTypes
    // is on, and an explicit `thinking_level: undefined` is also the shape most
    // likely to be serialized into the request body as a null and rejected.
    // Omitting the key entirely is what "use the model's default" has to mean.
    ...(thinkingLevel === undefined
      ? {}
      : { generation_config: { thinking_level: thinkingLevel } }),
  });

  const latencyMs = Math.round(performance.now() - startedAt);

  const outputText = interaction.output_text;
  if (outputText === undefined || outputText.trim() === "") {
    throw new Error(
      `Gemini returned no text for stage "${stage}" (interaction ${interaction.id}, ` +
        `status ${String(interaction.status)}). This is usually a safety block or a ` +
        "schema the model could not satisfy."
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(outputText);
  } catch {
    // response_format is supposed to make this impossible. If it ever fires,
    // the API changed and docs/research.md is wrong — say so loudly rather than
    // adding a regex that quietly papers over it.
    throw new Error(
      `Gemini returned non-JSON for stage "${stage}" despite response_format. ` +
        `First 200 chars: ${outputText.slice(0, 200)}`
    );
  }

  const data = schema.parse(parsedJson);

  /**
   * Missing usage is an error, not a zero.
   *
   * `?? 0` here used to mean that a renamed usage field — exactly the kind of
   * mid-hackathon SDK change this module exists to absorb — would degrade into
   * a cost panel confidently rendering zeros. docs/SPEC.md section e sells that
   * telemetry as evidence that the reasoning is worth what it costs, so silently
   * reporting that it cost nothing is worse than failing. `total_thought_tokens`
   * keeps its fallback: a call made with thinking off legitimately has none.
   */
  const usage = interaction.usage;
  if (
    usage?.total_input_tokens === undefined ||
    usage.total_output_tokens === undefined
  ) {
    throw new Error(
      `Gemini reported no token usage for stage "${stage}". Expected ` +
        "usage.total_input_tokens and usage.total_output_tokens (verified " +
        `2026-09-07, docs/research.md); got: ${JSON.stringify(usage)}. The SDK ` +
        "response shape changed — update docs/research.md rather than defaulting to 0."
    );
  }

  const call: ModelCall = {
    stage,
    model: GEMINI_MODEL,
    inputTokens: usage.total_input_tokens,
    outputTokens: usage.total_output_tokens,
    // Billed as output but reported separately, so a stage that is expensive
    // because it thinks is distinguishable from one that writes a lot.
    thoughtTokens: usage.total_thought_tokens ?? 0,
    latencyMs,
  };

  logger?.debug(
    { ...call, thinkingLevel: thinkingLevel ?? "default" },
    `gemini ${stage}`
  );

  return { data, call, raw: interaction };
}
