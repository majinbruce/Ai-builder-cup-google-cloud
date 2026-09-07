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

const AUDIO_MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mp3",
  ".wav": "audio/wav",
  ".m4a": "audio/m4a",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
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
  | { type: "text"; text: string }
  | { type: "audio"; data: string; mime_type: string };

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
        `Supported: ${Object.keys(AUDIO_MIME_TYPES).join(", ")}`
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
  const { schema, prompt, parts = [], stage, logger } = options;

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

  const usage = interaction.usage;
  const call: ModelCall = {
    stage,
    model: GEMINI_MODEL,
    inputTokens: usage?.total_input_tokens ?? 0,
    outputTokens: usage?.total_output_tokens ?? 0,
    thoughtTokens: usage?.total_thought_tokens ?? 0,
    latencyMs,
  };

  logger?.debug({ ...call }, `gemini ${stage}`);

  return { data, call, raw: interaction };
}
