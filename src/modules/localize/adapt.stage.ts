import { generateJson, type CallLogger, type ThinkingLevel } from "../../lib/gemini.ts";
import { loadPrompt } from "../../lib/prompts.ts";
import { charBudget } from "./drift.ts";
import { AdaptationBrief, AdaptedSegment } from "./localize.schemas.ts";
import type {
  Adaptation,
  Analysis,
  AnalyzedSegment,
  ModelCall,
  SegmentCritique,
} from "./localize.schemas.ts";

/**
 * ============================================================================
 * Stage 2 of docs/SPEC.md section b — adapt, in two moves.
 * ============================================================================
 *
 * 2a writes a brief over the whole analysis. 2b re-teaches each segment in
 * Hindi, one model call per segment, walked in order with everything already
 * adapted in context.
 *
 * One call per segment is a deliberate choice with a real cost — a 12-segment
 * clip is 12 sequential requests — and three benefits that paid for it:
 *
 *   1. Every request's `response_format` is a single AdaptedSegment, two levels
 *      deep. docs/SPEC.md section g lists "structured output rejects a deeply
 *      nested schema" as a live risk; for this stage it is now retired.
 *   2. A segment the critique fails is one cheap retry, not a re-run of the
 *      whole transcript. The bounded loop in section b is only bounded in cost
 *      because of this.
 *   3. The sequential context is explicit and inspectable — buildSegmentInput()
 *      below is a pure function you can print and read — rather than an emergent
 *      property of how the decoder happened to attend to a long output.
 *
 * Like analyze.stage.ts, this lives in the module rather than in the CLI script
 * because it has two callers: src/scripts/stage-adapt.ts today and the Phase 4
 * job service later. A stage implemented inside a script gets copied when the
 * API arrives, and the copy is where the two drift apart.
 */

const BRIEF_PROMPT = "brief.v1";
const ADAPT_PROMPT = "adapt.v1";

/** Hindi only in Phase 2. A second language is a NICE, per CLAUDE.md. */
export const TARGET_LANGUAGE = "hi";

export interface BriefInput {
  analysis: Analysis;
  logger?: CallLogger;
  thinkingLevel?: ThinkingLevel;
}

export interface BriefOutput {
  brief: AdaptationBrief;
  call: ModelCall;
}

/**
 * Stage 2a — one call over the whole analysis, no segment adapted.
 *
 * The model sees every segment's text, role, register and key terms at once,
 * which is the only point at which anything in this pipeline has a view of the
 * clip as a whole. Terminology consistency is decided here or not at all: a
 * glossary derived per segment is a record of the drift rather than a fix.
 */
export async function runBrief(input: BriefInput): Promise<BriefOutput> {
  const { analysis, logger, thinkingLevel } = input;

  const { data: brief, call } = await generateJson({
    schema: AdaptationBrief,
    prompt: loadPrompt(BRIEF_PROMPT),
    parts: [{ type: "text", text: formatAnalysisForBrief(analysis) }],
    // Its own stage, not "adapt". One call over the whole clip is a different
    // animal from one call per segment, and SPEC section d's per-segment cost
    // footer would otherwise bill a whole-clip call to one arbitrary segment.
    stage: "brief",
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(logger === undefined ? {} : { logger }),
  });

  logger?.debug(
    { glossaryTerms: brief.glossary.length, persona: brief.instructorPersona },
    "brief written"
  );

  return { brief, call };
}

export interface AdaptInput {
  analysis: Analysis;
  brief: AdaptationBrief;
  logger?: CallLogger;
  thinkingLevel?: ThinkingLevel;
  /** Called after each segment, so a CLI can show progress on a slow stage. */
  onSegment?: (segment: AdaptedSegment, index: number, total: number) => void;
}

export interface AdaptOutput {
  adaptation: Adaptation;
  calls: ModelCall[];
}

/**
 * Stage 2b — every segment, in order, each with the previous ones in context.
 *
 * Sequential and not parallel, on purpose. Parallelising this would cut the
 * wall clock by an order of magnitude and destroy the thing the stage is for:
 * segment 11 can only match segment 3's wording if segment 3 already exists
 * when segment 11 is written. Callbacks ("remember that word") and terminology
 * continuity are not decorations, they are what separates a localized lecture
 * from a bag of independently translated sentences.
 */
export async function runAdapt(input: AdaptInput): Promise<AdaptOutput> {
  const { analysis, brief, logger, thinkingLevel, onSegment } = input;

  const prompt = loadPrompt(ADAPT_PROMPT);
  const adapted: AdaptedSegment[] = [];
  const calls: ModelCall[] = [];

  for (const [index, segment] of analysis.segments.entries()) {
    const { data, call } = await generateJson({
      schema: AdaptedSegment,
      prompt,
      parts: [{ type: "text", text: buildSegmentInput(brief, segment, adapted) }],
      stage: "adapt",
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(logger === undefined ? {} : { logger }),
    });

    adapted.push(withId(data, segment.id));
    calls.push(call);
    onSegment?.(
      adapted[adapted.length - 1] as AdaptedSegment,
      index,
      analysis.segments.length
    );
  }

  return {
    adaptation: { targetLanguage: TARGET_LANGUAGE, brief, segments: adapted },
    calls,
  };
}

export interface RetryInput {
  analysis: Analysis;
  adaptation: Adaptation;
  /** Only the segments that failed. Selected by critique.stage.ts. */
  critiques: SegmentCritique[];
  logger?: CallLogger;
  thinkingLevel?: ThinkingLevel;
  onSegment?: (segment: AdaptedSegment, index: number, total: number) => void;
}

export interface RetryOutput {
  /** The full adaptation with the retried segments substituted in place. */
  adaptation: Adaptation;
  calls: ModelCall[];
  retriedIds: string[];
}

/**
 * The one-shot retry of docs/SPEC.md section b.
 *
 * Exactly once, and the second result is kept regardless of whether it is
 * better. That is what makes the loop bounded, and the bound is the honest
 * part: a loop that retried until the critic was satisfied would converge on
 * output the critic likes, which — given both are the same model family — is a
 * different objective from output that teaches. The UI shows the retry badge
 * and the scores that triggered it, so a reader can see the failure that led
 * here rather than only the result.
 *
 * The retried segment sees the same sequential context it saw the first time,
 * plus the critique. Segments AFTER it are not re-adapted: they were written
 * against the first version, so a retry can strand a callback. That is a real
 * limitation of a bounded loop and it is recorded rather than papered over —
 * the glossary, which is what most callbacks depend on, is unchanged by a
 * retry, so the exposure is narrower than it sounds.
 */
export async function runAdaptRetry(input: RetryInput): Promise<RetryOutput> {
  const { analysis, adaptation, critiques, logger, thinkingLevel, onSegment } = input;

  const prompt = loadPrompt(ADAPT_PROMPT);
  const sourceById = new Map(analysis.segments.map((segment) => [segment.id, segment]));
  const segments = [...adaptation.segments];
  const calls: ModelCall[] = [];
  const retriedIds: string[] = [];

  for (const [index, critique] of critiques.entries()) {
    const source = sourceById.get(critique.id);
    const position = segments.findIndex((segment) => segment.id === critique.id);

    if (source === undefined || position === -1) {
      // Not recoverable by skipping: the critique is scoring a segment that is
      // not in the analysis, which means the two artifacts are from different
      // runs. Continuing would silently produce a job whose scores describe
      // text nobody can see.
      throw new Error(
        `Critique references segment "${critique.id}", which is not in ` +
          `${source === undefined ? "the analysis" : "the adaptation"}. The analysis, ` +
          "adaptation and critique are from different runs — re-run the pipeline."
      );
    }

    const { data, call } = await generateJson({
      schema: AdaptedSegment,
      prompt,
      parts: [
        {
          type: "text",
          text:
            buildSegmentInput(adaptation.brief, source, segments.slice(0, position)) +
            "\n\n" +
            formatCritiqueForRetry(critique),
        },
      ],
      stage: "adapt_retry",
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(logger === undefined ? {} : { logger }),
    });

    segments[position] = withId(data, critique.id);
    calls.push(call);
    retriedIds.push(critique.id);
    onSegment?.(segments[position], index, critiques.length);
  }

  return { adaptation: { ...adaptation, segments }, calls, retriedIds };
}

/**
 * Pins a returned segment to the id it was asked about.
 *
 * The schema requires an `id` but cannot require the RIGHT one, and a model
 * that renumbers its own output would silently misalign every downstream join:
 * the critique would score one segment's Hindi against another's English, and
 * the reasoning panel would show a learner the wrong pair. Throwing here costs
 * one call; not throwing costs a demo where nothing lines up and nothing
 * obviously fails.
 */
function withId(segment: AdaptedSegment, expectedId: string): AdaptedSegment {
  if (segment.id !== expectedId) {
    throw new Error(
      `Adapt returned segment id "${segment.id}" when asked for "${expectedId}". ` +
        "Ids are the join between analysis, adaptation and critique, so this is not " +
        "safe to renumber automatically."
    );
  }

  return segment;
}

/**
 * The whole analysis, flattened for the brief call.
 *
 * Text rather than raw JSON because the brief is a reading task, not a parsing
 * one: the model has to form a picture of a person from twelve rows, and the
 * fields that matter for that (role, register, pace, terms) are easier to scan
 * down a column than to pick out of nested objects. Timestamps and confidences
 * are omitted for the same reason — nothing in the brief depends on them.
 */
export function formatAnalysisForBrief(analysis: Analysis): string {
  const lines: string[] = [
    "## The recording",
    "",
    `Topic: ${analysis.topic}`,
    `Audience (as analyzed): ${analysis.audience}`,
    `Source language: ${analysis.sourceLanguage}`,
    `Target language: Hindi (${TARGET_LANGUAGE})`,
    `Segments: ${analysis.segments.length}`,
    "",
    "## The segments, in order",
    "",
  ];

  for (const segment of analysis.segments) {
    lines.push(
      `### ${segment.id} — ${segment.signal} · ${segment.register} · ${segment.pace}`
    );
    lines.push(`"${segment.text}"`);

    if (segment.keyTerms.length > 0) {
      lines.push(`Key terms: ${segment.keyTerms.join(", ")}`);
    }
    if (segment.emphasis.length > 0) {
      lines.push(`Stressed: ${segment.emphasis.map((marker) => marker.term).join(", ")}`);
    }
    for (const idiom of segment.idioms) {
      lines.push(`${idiom.kind}: "${idiom.phrase}" — means: ${idiom.intendedMeaning}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Everything one adapt call sees: the brief, the work so far, and this segment.
 *
 * Exported and pure so that `stage-adapt.ts --dry-run` can print the exact text
 * that would be sent without spending a request, and so a test can assert what
 * is in it. Prompt iteration on a stage that costs a dozen calls per run needs
 * an inspection path that costs nothing.
 */
export function buildSegmentInput(
  brief: AdaptationBrief,
  segment: AnalyzedSegment,
  alreadyAdapted: AdaptedSegment[]
): string {
  const lines: string[] = [
    "## The brief",
    "",
    `Topic: ${brief.topic}`,
    `Audience: ${brief.audience}`,
    `Instructor persona: ${brief.instructorPersona}`,
    `Register guidance: ${brief.registerGuidance}`,
    "",
    "### Glossary — use these target forms exactly",
    "",
  ];

  if (brief.glossary.length === 0) {
    lines.push("(empty — no terms were fixed for this clip)");
  }
  for (const entry of brief.glossary) {
    lines.push(
      `- ${entry.english} -> ${entry.targetForm} (${entry.decision}) — ${entry.why}`
    );
  }

  lines.push("", "## Already adapted, in order", "");

  if (alreadyAdapted.length === 0) {
    lines.push("(nothing yet — this is the first segment of the clip)");
  } else {
    // Every prior segment's Hindi, so a callback can be matched word for word,
    // but only the immediately previous one's reasoning and terms in full. The
    // whole history of rationales would crowd out the segment being adapted
    // without helping: what continuity needs is the words, not the arguments.
    for (const previous of alreadyAdapted) {
      lines.push(`${previous.id}: ${previous.targetText}`);
    }

    const last = alreadyAdapted[alreadyAdapted.length - 1] as AdaptedSegment;
    lines.push("");
    lines.push(`Most recent segment (${last.id}) in full:`);
    lines.push(`  rationale: ${last.rationale}`);
    lines.push(`  glossary terms used: ${last.termsUsed.join(", ") || "(none)"}`);
    lines.push(`  register/style: ${last.ttsHints.style}`);
  }

  lines.push("", "## Adapt this segment now", "");
  lines.push(`id: ${segment.id}   (return this exact id)`);
  lines.push(`time: ${segment.startSec.toFixed(1)}s - ${segment.endSec.toFixed(1)}s`);
  lines.push(
    `pedagogical signal: ${segment.signal} (confidence ${segment.signalConfidence})`
  );
  lines.push(`why that label: ${segment.signalEvidence}`);
  lines.push(`register: ${segment.register}   pace: ${segment.pace}`);
  lines.push("");
  lines.push(`English: "${segment.text}"`);
  lines.push("");

  if (segment.emphasis.length === 0) {
    lines.push("Stressed terms: none — the speaker was flat here. Do not invent stress.");
  } else {
    lines.push("Stressed terms — each needs a Hindi counterpart in emphasisTerms:");
    for (const marker of segment.emphasis) {
      lines.push(
        `- "${marker.term}" (${marker.strength}) — heard as: ${marker.evidence}`
      );
    }
  }

  if (segment.idioms.length > 0) {
    lines.push("");
    lines.push("Idioms and references — a literal rendering destroys these:");
    for (const idiom of segment.idioms) {
      lines.push(
        `- "${idiom.phrase}" (${idiom.kind}) — literally: ${idiom.literalMeaning}; ` +
          `doing the job of: ${idiom.intendedMeaning}`
      );
    }
  }

  if (segment.keyTerms.length > 0) {
    lines.push("");
    lines.push(`Key terms in this segment: ${segment.keyTerms.join(", ")}`);
  }

  lines.push("");
  lines.push(
    `Soft length budget: about ${charBudget(segment)} Devanagari characters ` +
      `(the speaker took ${(segment.endSec - segment.startSec).toFixed(1)}s). ` +
      "Go over it when the teaching needs the room; never pad to reach it."
  );

  return lines.join("\n");
}

/**
 * The critique, formatted for the revision attempt.
 *
 * Deliberately narrow: the back-translation, the quoted translationese, the
 * issues and the suggestion. The numeric scores are NOT included. A model told
 * "you scored 62" optimizes for a higher number on the next pass, and there is
 * no next pass — this is the one revision, and what it needs is the list of
 * specific things that were wrong, not a grade to beat.
 */
export function formatCritiqueForRetry(critique: SegmentCritique): string {
  const lines: string[] = [
    "## Revision requested",
    "",
    "Your previous Hindi for this segment was reviewed by a reader who could not",
    "see your reasoning. Here is what they found. Fix these things; leave the rest",
    "alone.",
    "",
    `What your Hindi actually said, read back: "${critique.backTranslation}"`,
    "",
  ];

  if (!critique.signalPreserved) {
    lines.push(
      "The instructional move did NOT survive — the segment no longer does the job",
      "its signal label says it does. This is the most important thing to fix.",
      ""
    );
  }
  if (!critique.emphasisPreserved) {
    lines.push(
      "A stressed term from the original has no counterpart that can carry the",
      "stress in your Hindi. Give it one.",
      ""
    );
  }
  if (critique.translationese.length > 0) {
    lines.push("Constructions that read as translated rather than spoken:");
    for (const quote of critique.translationese) {
      lines.push(`- "${quote}"`);
    }
    lines.push("");
  }
  if (critique.issues.length > 0) {
    lines.push("Issues:");
    for (const issue of critique.issues) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
  }
  if (critique.suggestion !== undefined) {
    lines.push(`Suggested fix: ${critique.suggestion}`, "");
  }

  lines.push("Return the same segment id. This revision is final.");

  return lines.join("\n");
}
