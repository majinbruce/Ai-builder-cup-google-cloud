import { generateJson, type CallLogger, type ThinkingLevel } from "../../lib/gemini.ts";
import { loadPrompt } from "../../lib/prompts.ts";
import { findLatinRuns } from "./drift.ts";
import { Critique } from "./localize.schemas.ts";
import type {
  Adaptation,
  AdaptedSegment,
  Analysis,
  AnalyzedSegment,
  ModelCall,
  SegmentCritique,
} from "./localize.schemas.ts";

/**
 * ============================================================================
 * Stage 3 of docs/SPEC.md section b — the blind back-translation check.
 * ============================================================================
 *
 * What this is, said plainly before any of it runs: the same model family
 * scoring output it produced. It is NOT an independent review and the project
 * does not present it as one.
 *
 * What blinding actually buys is narrow and real. buildCritiqueInput() below
 * constructs the critic's entire input from the source English, the signal
 * label, the source's stressed terms and the Hindi. The rationale, the brief,
 * the glossary, the literal control text and the TTS hints are not omitted by
 * instruction — they are structurally unreachable from the value that function
 * returns. So the critic cannot launder a bad rendering by reading the
 * justification written for it, because there is no justification in the room.
 *
 * That property is worth exactly as much as it is enforced, which is why it is
 * enforced here in code and asserted in test/adapt.test.ts rather than
 * requested in critique.v1.md. A prompt that says "do not consider the
 * rationale" is a promise; a function that never puts it in the payload is a
 * mechanism.
 */

const CRITIQUE_PROMPT = "critique.v1";

/**
 * Below any of these, a segment is re-adapted once. docs/SPEC.md section b.
 *
 * Exported because the number belongs in the audit trail, not only in the
 * branch: the UI states the threshold next to the score, so a reader can see
 * that a 71 passed and a 69 did not, and disagree with where the line is.
 */
export const RETRY_THRESHOLD = 70;

/**
 * One source/target pair as the critic sees it.
 *
 * This interface IS the blindness guarantee. Adding a field here is the only
 * way something reaches the critic, so the review question "does the critic
 * still not see the reasoning" is answerable by reading five lines.
 */
export interface CritiquePair {
  id: string;
  /** The English the speaker said. */
  sourceText: string;
  /** The instructional move, so signalPreserved is a checkable question. */
  signal: AnalyzedSegment["signal"];
  /** Source-side stressed terms only — never the adapter's emphasisTerms. */
  stressedTerms: string[];
  /** The Hindi, and nothing that came with it. */
  targetText: string;
}

export interface CritiqueInput {
  analysis: Analysis;
  adaptation: Adaptation;
  logger?: CallLogger;
  thinkingLevel?: ThinkingLevel;
}

export interface CritiqueOutput {
  critique: Critique;
  call: ModelCall;
}

/**
 * Builds the critic's input. Pure, and the narrowest function in the pipeline.
 *
 * Note what is NOT read off the AdaptedSegment: `rationale`, `choices`,
 * `literalText`, `termsUsed`, `emphasisTerms`, `ttsHints`. And what is not read
 * off the Adaptation at all: `brief`, and with it the glossary. `emphasisTerms`
 * is excluded for a subtler reason than the rest — it is the adapter's own
 * claim about which Hindi tokens carry the stress, and handing that to a critic
 * asked whether the emphasis survived would be asking it to check an assertion
 * against itself. The critic gets the ENGLISH terms the speaker stressed and
 * has to find them in the Hindi on its own.
 */
export function buildCritiqueInput(
  analysis: Analysis,
  adaptation: Adaptation
): CritiquePair[] {
  const targetById = new Map(
    adaptation.segments.map((segment) => [segment.id, segment.targetText])
  );

  const pairs: CritiquePair[] = [];

  for (const segment of analysis.segments) {
    const targetText = targetById.get(segment.id);
    if (targetText === undefined) {
      throw new Error(
        `No adapted text for segment "${segment.id}". Every analyzed segment must be ` +
          "adapted before critique; the adaptation is incomplete or from another run."
      );
    }

    pairs.push({
      id: segment.id,
      sourceText: segment.text,
      signal: segment.signal,
      stressedTerms: segment.emphasis.map((marker) => marker.term),
      targetText,
    });
  }

  return pairs;
}

/**
 * One call for the whole clip, unlike adapt.
 *
 * The asymmetry is intentional. Adapt is sequential because each segment's
 * output depends on the previous ones; critique has no such dependency — each
 * pair is scored against its own source — and `overallFidelity` genuinely wants
 * the whole clip in view, since a run where every segment is decent but the one
 * definition is wrong should not average out to fine.
 */
export async function runCritique(input: CritiqueInput): Promise<CritiqueOutput> {
  const { analysis, adaptation, logger, thinkingLevel } = input;

  const pairs = buildCritiqueInput(analysis, adaptation);

  const { data: critique, call } = await generateJson({
    schema: Critique,
    prompt: loadPrompt(CRITIQUE_PROMPT),
    parts: [{ type: "text", text: formatPairsForCritique(pairs) }],
    stage: "critique",
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(logger === undefined ? {} : { logger }),
  });

  const missing = pairs
    .filter((pair) => !critique.segments.some((scored) => scored.id === pair.id))
    .map((pair) => pair.id);

  if (missing.length > 0) {
    // An unscored segment is not a gap in a report, it is a segment that
    // silently skips the retry gate. The overall scores would also be computed
    // over a set the reader thinks is complete.
    throw new Error(
      `Critique did not score ${missing.length} segment(s): ${missing.join(", ")}. ` +
        "Every segment must be scored or the retry gate and the overall scores are " +
        "both computed over an incomplete set."
    );
  }

  return { critique, call };
}

/** Why a segment is being sent back, in the words the UI shows. */
export interface RetryReason {
  critique: SegmentCritique;
  reasons: string[];
}

/**
 * The segments that go back through Adapt, once.
 *
 * Four triggers, and the fourth is not from the model. `fidelity`,
 * `naturalness` and `signalPreserved` are the critic's judgment (SPEC section
 * b); Latin script in `targetText` is a measured fact about the string, checked
 * by findLatinRuns() with no model involved. It belongs in the same gate
 * because it has the same consequence — a segment that cannot be synthesized
 * correctly on hi-IN is as broken as one that no longer teaches — and it is the
 * one trigger in this pipeline that cannot be talked out of firing.
 *
 * `alreadyRetried` enforces the bound. docs/SPEC.md section b: failing segments
 * are re-adapted ONCE and the second result is kept regardless. Passing the ids
 * that have already been through means the caller cannot accidentally build a
 * loop by calling this again with the retried critique.
 */
export function selectForRetry(
  critique: Critique,
  adaptation: Adaptation,
  alreadyRetried: readonly string[] = []
): RetryReason[] {
  const retried = new Set(alreadyRetried);
  const targetById = new Map(adaptation.segments.map((segment) => [segment.id, segment]));

  const selected: RetryReason[] = [];

  for (const scored of critique.segments) {
    if (retried.has(scored.id)) continue;

    const reasons: string[] = [];

    if (scored.fidelity < RETRY_THRESHOLD) {
      reasons.push(`fidelity ${scored.fidelity} < ${RETRY_THRESHOLD}`);
    }
    if (scored.naturalness < RETRY_THRESHOLD) {
      reasons.push(`naturalness ${scored.naturalness} < ${RETRY_THRESHOLD}`);
    }
    if (!scored.signalPreserved) {
      reasons.push("the instructional move did not survive");
    }

    const latin = findLatinRuns(targetById.get(scored.id)?.targetText ?? "");
    if (latin.length > 0) {
      reasons.push(
        `Latin script in the text sent to hi-IN TTS: ${latin
          .map((run) => `"${run.text}"`)
          .join(", ")}`
      );
    }

    if (reasons.length > 0) selected.push({ critique: scored, reasons });
  }

  return selected;
}

/**
 * Latin-script violations across a whole adaptation, for reporting.
 *
 * Separate from selectForRetry because this one is worth printing even when
 * nothing needs retrying: it is a measured property of the artifact, and a run
 * with zero violations is evidence that the Devanagari-only rule in
 * adapt.v1.md is actually being followed rather than merely stated.
 */
export function latinScriptViolations(
  adaptation: Adaptation
): { id: string; runs: string[] }[] {
  return adaptation.segments
    .map((segment: AdaptedSegment) => ({
      id: segment.id,
      runs: findLatinRuns(segment.targetText).map((run) => run.text),
    }))
    .filter((entry) => entry.runs.length > 0);
}

/**
 * The pairs as text for the model.
 *
 * Exported and pure so a test can assert on the exact string that goes over the
 * wire — the blindness claim is about the payload, so the payload is what the
 * test has to see, not the object it was built from.
 */
export function formatPairsForCritique(pairs: CritiquePair[]): string {
  const lines: string[] = [
    "## Segments to review",
    "",
    `${pairs.length} segments. Score every one, under the id given.`,
    "",
  ];

  for (const pair of pairs) {
    lines.push(`### ${pair.id}`);
    lines.push(`Instructional move the original was performing: ${pair.signal}`);
    lines.push(`English original: "${pair.sourceText}"`);
    lines.push(
      pair.stressedTerms.length === 0
        ? "Terms the speaker stressed: none"
        : `Terms the speaker stressed: ${pair.stressedTerms.join(", ")}`
    );
    lines.push(`Hindi produced: "${pair.targetText}"`);
    lines.push("");
  }

  return lines.join("\n");
}
