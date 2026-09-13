import { audioPart, generateJson, type CallLogger } from "../../lib/gemini.ts";
import { loadPrompt } from "../../lib/prompts.ts";
import { formatAcousticsForPrompt, measureAcoustics } from "./acoustics.ts";
import { corroborate } from "./corroborate.ts";
import { Analysis } from "./localize.schemas.ts";
import type { AcousticEvidence, Corroboration, ModelCall } from "./localize.schemas.ts";

/**
 * Stage 1 of docs/SPEC.md section b, as one callable unit.
 *
 * It lives here rather than in the CLI script because there are two callers,
 * not one: `src/scripts/stage-analyze.ts` today, and the Phase 4 job service
 * later. A stage whose only implementation is inside a script gets copied into
 * the service when the API arrives, and the copy is where the two drift.
 *
 * Takes its logger as an argument rather than importing one, per the Ctx rule
 * in CLAUDE.md — the script passes a stdout stand-in, Fastify passes
 * `request.log`, and neither has to know about the other.
 */

/** The prompt file this stage is pinned to. Bumping it is an edit here. */
const ANALYZE_PROMPT = "analyze.v1";

export interface AnalyzeInput {
  /** Local path to a decodable audio file, already normalized by ingest. */
  audioPath: string;
  logger?: CallLogger;
}

export interface AnalyzeOutput {
  analysis: Analysis;
  /** What ffmpeg measured — fed to the prompt, and kept for the audit panel. */
  evidence: AcousticEvidence;
  /** The model's emphasis claims scored against that measurement. */
  corroboration: Corroboration;
  call: ModelCall;
}

/**
 * Measure, analyze, then check the analysis against the measurement.
 *
 * The order is the point. The measurements are computed once and used twice —
 * as context the model reasons with, and as the yardstick its claims are held
 * to afterwards. Using different numbers for the two jobs would make the check
 * meaningless, so there is exactly one `measureAcoustics` call here.
 */
export async function runAnalyze(input: AnalyzeInput): Promise<AnalyzeOutput> {
  const { audioPath, logger } = input;

  const evidence = await measureAcoustics(audioPath);

  logger?.debug(
    {
      durationSec: evidence.durationSec,
      meanVolumeDb: evidence.meanVolumeDb,
      silenceThresholdDb: evidence.silenceThresholdDb,
      pauses: evidence.pauses.length,
      windows: evidence.windows.length,
    },
    "acoustics measured"
  );

  const { data: analysis, call } = await generateJson({
    schema: Analysis,
    prompt: loadPrompt(ANALYZE_PROMPT),
    parts: [
      { type: "text", text: formatAcousticsForPrompt(evidence) },
      audioPart(audioPath),
    ],
    stage: "analyze",
    ...(logger === undefined ? {} : { logger }),
  });

  assertSegmentIds(analysis);

  return { analysis, evidence, corroboration: corroborate(analysis, evidence), call };
}

/** Short and path-safe. The prompt asks for `s01`, `s02`, …; this is the floor. */
const SEGMENT_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Segment ids are the join key for every later stage, so they are checked once,
 * here, where the model first invents them.
 *
 * Not in the Zod schema: uniqueness across an array is a refinement, which JSON
 * Schema conversion drops, so it would read as enforced for the model while only
 * ever being enforced by the parse. A duplicate id makes adapt, critique and
 * synthesis each pick "the first match" and pair the wrong texts without failing.
 */
export function assertSegmentIds(analysis: Analysis): void {
  const seen = new Set<string>();

  for (const segment of analysis.segments) {
    if (!SEGMENT_ID.test(segment.id)) {
      throw new Error(
        `Analyze returned segment id ${JSON.stringify(segment.id)}, which is not a ` +
          "short alphanumeric id. Ids are join keys; refusing to carry it forward."
      );
    }
    if (seen.has(segment.id)) {
      throw new Error(
        `Analyze returned segment id "${segment.id}" more than once. Ids are the join ` +
          "between analysis, adaptation, critique and synthesis, so they must be unique."
      );
    }
    seen.add(segment.id);
  }
}
