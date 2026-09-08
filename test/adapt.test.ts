import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildSegmentInput,
  formatAnalysisForBrief,
  formatCritiqueForRetry,
} from "../src/modules/localize/adapt.stage.ts";
import {
  buildCritiqueInput,
  CRITIQUE_THINKING_LEVEL,
  formatPairsForCritique,
  latinScriptViolations,
  RETRY_THRESHOLD,
  selectForRetry,
} from "../src/modules/localize/critique.stage.ts";
import {
  charBudget,
  countSpokenChars,
  MEASURED_CHARS_PER_SEC,
  findLatinRuns,
  measureDrift,
} from "../src/modules/localize/drift.ts";
import {
  Adaptation,
  AdaptationBrief,
  AdaptedSegment,
  Critique,
  ModelCallStage,
  type Analysis,
  type AnalyzedSegment,
  type SegmentCritique,
} from "../src/modules/localize/localize.schemas.ts";

/**
 * Stage 2 and 3 without a network call.
 *
 * Same principle as test/analyze.test.ts: a mocked model proves nothing about a
 * prompt, so nothing here pretends to test the quality of the Hindi. What IS
 * testable is every structural guarantee the phase makes — that the critic is
 * blind, that the retry loop is bounded, that ids join the three artifacts
 * correctly, that Devanagari-only is enforced rather than requested — and those
 * guarantees are exactly the ones whose failure would be invisible in output
 * that still looks plausible.
 *
 * The blindness suite at the bottom of this file is the one that matters most.
 * It is the only thing standing between "the critique is blind" and "the
 * critique is blind until someone adds a field to AdaptedSegment".
 */

/* -------------------------------------------------------------------------- */
/* Fixtures — every field carries a searchable sentinel                       */
/* -------------------------------------------------------------------------- */

/**
 * Sentinels rather than realistic text, deliberately.
 *
 * The blindness assertions work by searching the built payload for strings that
 * must not be there. Realistic prose would risk a false pass (a phrase that
 * happens not to appear) and a false fail (a common word appearing for an
 * unrelated reason). A unique token per field makes both impossible.
 */
const LEAK = {
  rationale: "SENTINEL_RATIONALE_a1",
  choiceWhy: "SENTINEL_CHOICE_WHY_b2",
  choiceOriginal: "SENTINEL_CHOICE_ORIGINAL_c3",
  literal: "SENTINEL_LITERAL_d4",
  glossaryWhy: "SENTINEL_GLOSSARY_WHY_e5",
  glossaryTarget: "SENTINEL_GLOSSARY_TARGET_f6",
  persona: "SENTINEL_PERSONA_g7",
  registerGuidance: "SENTINEL_REGISTER_h8",
  ttsStyle: "SENTINEL_TTS_STYLE_i9",
  emphasisTerm: "SENTINEL_EMPHASIS_TERM_j10",
  termsUsed: "SENTINEL_TERMS_USED_k11",
} as const;

function analyzedSegment(overrides: Partial<AnalyzedSegment> = {}): AnalyzedSegment {
  return {
    id: "s01",
    startSec: 0,
    endSec: 10,
    text: "A closure is a function that remembers the variables around it.",
    signal: "definition",
    signalConfidence: 0.9,
    signalEvidence: "The speaker names a term and states what it means.",
    register: "neutral",
    pace: "slow",
    emphasis: [{ term: "closure", strength: "strong", evidence: "louder, pause after" }],
    idioms: [],
    keyTerms: ["closure"],
    ...overrides,
  };
}

function analysis(segments: AnalyzedSegment[] = [analyzedSegment()]): Analysis {
  return {
    sourceLanguage: "en",
    topic: "closures in JavaScript",
    audience: "beginner developers",
    segments,
  };
}

function adaptedSegment(overrides: Partial<AdaptedSegment> = {}): AdaptedSegment {
  return {
    id: "s01",
    targetText: "क्लोज़र एक ऐसा फ़ंक्शन है जो अपने आसपास के वेरिएबल याद रखता है।",
    literalText: LEAK.literal,
    termsUsed: [LEAK.termsUsed],
    rationale: LEAK.rationale,
    emphasisTerms: [LEAK.emphasisTerm],
    choices: [
      {
        kind: "term_kept_english",
        original: LEAK.choiceOriginal,
        adapted: "क्लोज़र",
        why: LEAK.choiceWhy,
      },
    ],
    ttsHints: { speakingRate: 0.85, pauseBefore: "short", style: LEAK.ttsStyle },
    ...overrides,
  };
}

function brief(overrides: Partial<AdaptationBrief> = {}): AdaptationBrief {
  return {
    topic: "closures in JavaScript",
    audience: "beginner developers",
    instructorPersona: LEAK.persona,
    registerGuidance: LEAK.registerGuidance,
    glossary: [
      {
        english: "closure",
        decision: "transliterate",
        targetForm: LEAK.glossaryTarget,
        why: LEAK.glossaryWhy,
      },
    ],
    ...overrides,
  };
}

function adaptation(segments: AdaptedSegment[] = [adaptedSegment()]): Adaptation {
  return { targetLanguage: "hi", brief: brief(), segments };
}

function segmentCritique(overrides: Partial<SegmentCritique> = {}): SegmentCritique {
  return {
    id: "s01",
    backTranslation: "A closure is a function that remembers its surrounding variables.",
    fidelity: 90,
    naturalness: 90,
    translationese: [],
    signalPreserved: true,
    emphasisPreserved: true,
    issues: [],
    ...overrides,
  };
}

function critique(segments: SegmentCritique[] = [segmentCritique()]): Critique {
  return { overallFidelity: 90, overallNaturalness: 90, segments };
}

/* -------------------------------------------------------------------------- */

describe("critique blindness", () => {
  /**
   * The load-bearing test of Phase 2.
   *
   * docs/SPEC.md section b claims the critic back-translates "without seeing the
   * English rationale or the brief". That claim is only worth something if it is
   * a property of the payload rather than a request in the prompt, so this walks
   * the actual string that goes over the wire and asserts every sentinel is
   * absent. A field added to AdaptedSegment and carelessly forwarded fails here.
   */
  it("puts none of the adapter's reasoning in the critic's payload", () => {
    const payload = formatPairsForCritique(buildCritiqueInput(analysis(), adaptation()));

    for (const [field, sentinel] of Object.entries(LEAK)) {
      expect(payload, `${field} leaked into the critique payload`).not.toContain(
        sentinel
      );
    }
  });

  it("also keeps them out of the structured pairs, not just the rendered text", () => {
    const serialized = JSON.stringify(buildCritiqueInput(analysis(), adaptation()));

    for (const sentinel of Object.values(LEAK)) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("gives the critic the source English, the signal and the Hindi", () => {
    const [pair] = buildCritiqueInput(analysis(), adaptation());

    expect(pair?.sourceText).toContain("A closure is a function");
    expect(pair?.signal).toBe("definition");
    expect(pair?.targetText).toContain("क्लोज़र");
  });

  /**
   * The subtlest half of the guarantee.
   *
   * `emphasisPreserved` asks whether the stressed terms survived. Handing the
   * critic the adapter's own `emphasisTerms` list would be asking it to check an
   * assertion against itself — it would see the Hindi tokens the adapter
   * *claims* carry the stress, and confirming they are present proves nothing.
   * It gets the ENGLISH terms the speaker stressed and has to find them itself.
   */
  it("passes the source's stressed terms, never the adapter's emphasisTerms", () => {
    const [pair] = buildCritiqueInput(analysis(), adaptation());

    expect(pair?.stressedTerms).toEqual(["closure"]);
    expect(JSON.stringify(pair)).not.toContain(LEAK.emphasisTerm);
  });

  it("refuses to build a payload when a segment was never adapted", () => {
    const source = analysis([
      analyzedSegment({ id: "s01" }),
      analyzedSegment({ id: "s02" }),
    ]);

    expect(() => buildCritiqueInput(source, adaptation())).toThrow(/s02/);
  });
});

describe("the retry gate", () => {
  it("sends back a segment below the fidelity threshold", () => {
    const selected = selectForRetry(
      critique([segmentCritique({ fidelity: RETRY_THRESHOLD - 1 })]),
      adaptation()
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.reasons.join()).toMatch(/fidelity 69/);
  });

  it("keeps a segment exactly at the threshold", () => {
    // 70 passes and 69 does not. The boundary is stated in the UI next to the
    // score, so a reader can disagree with where the line is — which they can
    // only do if the line is where the code says it is.
    const selected = selectForRetry(
      critique([segmentCritique({ fidelity: RETRY_THRESHOLD })]),
      adaptation()
    );

    expect(selected).toHaveLength(0);
  });

  it("sends back a segment that is faithful but unnatural", () => {
    // The whole reason naturalness is scored separately: fidelity 98 would hide
    // this segment completely if the two axes were pooled into one number.
    const selected = selectForRetry(
      critique([segmentCritique({ fidelity: 98, naturalness: 41 })]),
      adaptation()
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.reasons.join()).toMatch(/naturalness 41/);
  });

  it("sends back a segment that scored well but lost the instructional move", () => {
    const selected = selectForRetry(
      critique([
        segmentCritique({ fidelity: 95, naturalness: 95, signalPreserved: false }),
      ]),
      adaptation()
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.reasons.join()).toMatch(/instructional move/);
  });

  it("sends back a segment with Latin script even when every score passed", () => {
    // The one trigger the model cannot talk out of firing: it is a measured
    // property of the string, not a judgment about it.
    const selected = selectForRetry(
      critique(),
      adaptation([adaptedSegment({ targetText: "यह एक closure है।" })])
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.reasons.join()).toMatch(/Latin script.*"closure"/);
  });

  it("leaves a clean segment alone", () => {
    expect(selectForRetry(critique(), adaptation())).toHaveLength(0);
  });

  /**
   * The bound itself. docs/SPEC.md section b: failing segments are re-adapted
   * ONCE and the second result is kept regardless. Without this, a caller that
   * re-scored after a retry would get the same segment back and loop.
   */
  it("never selects a segment that has already been retried", () => {
    const failing = critique([segmentCritique({ fidelity: 10, naturalness: 10 })]);

    expect(selectForRetry(failing, adaptation())).toHaveLength(1);
    expect(selectForRetry(failing, adaptation(), ["s01"])).toHaveLength(0);
  });

  it("reports every reason a segment failed, not just the first", () => {
    const selected = selectForRetry(
      critique([
        segmentCritique({ fidelity: 30, naturalness: 40, signalPreserved: false }),
      ]),
      adaptation([adaptedSegment({ targetText: "closure यह है।" })])
    );

    expect(selected[0]?.reasons).toHaveLength(4);
  });
});

describe("the Devanagari-only guard", () => {
  it("flags a Latin-script technical term left in the TTS string", () => {
    expect(findLatinRuns("यह एक closure है।")).toEqual([{ text: "closure", index: 6 }]);
  });

  it("accepts a transliterated term", () => {
    expect(findLatinRuns("यह एक क्लोज़र है।")).toEqual([]);
  });

  it("accepts digits, punctuation and whitespace", () => {
    // Chirp reads these in the voice's own language, so they carry no script
    // risk — flagging them would make the guard fire on every year and comma.
    expect(findLatinRuns("2026 में — लगभग 15%, ठीक है।")).toEqual([]);
  });

  it("finds every run, not only the first", () => {
    expect(findLatinRuns("closure और scope").map((run) => run.text)).toEqual([
      "closure",
      "scope",
    ]);
  });

  it("reports violations across a whole adaptation with their segment ids", () => {
    const result = latinScriptViolations(
      adaptation([
        adaptedSegment({ id: "s01" }),
        adaptedSegment({ id: "s02", targetText: "यह async है।" }),
      ])
    );

    expect(result).toEqual([{ id: "s02", runs: ["async"] }]);
  });
});

describe("length budgets and drift", () => {
  it("scales the budget with the source span", () => {
    const short = charBudget({ startSec: 0, endSec: 5 });
    const long = charBudget({ startSec: 0, endSec: 10 });

    expect(long).toBeGreaterThan(short);
    // Within one rounding quantum of exactly double, rather than exactly double:
    // charBudget() rounds to the nearest 5 so a prompt cannot read it as an exact
    // target, and rounding two spans independently does not distribute over
    // doubling. At 12.72 chars/sec, 5s budgets 65 and 10s budgets 125.
    expect(Math.abs(long - short * 2)).toBeLessThanOrEqual(5);
  });

  it("rounds the budget so a prompt cannot read it as an exact target", () => {
    expect(charBudget({ startSec: 0, endSec: 7.3 }) % 5).toBe(0);
  });

  it("counts only characters that take time to say", () => {
    // Whitespace is already priced into the rate and "।" is not a syllable, so
    // counting them would make the estimate track formatting rather than speech.
    expect(countSpokenChars("अब, यह — ठीक है।")).toBe(countSpokenChars("अबयहठीकहै"));
  });

  it("computes per-segment and overall drift against the source spans", () => {
    // Two seconds' worth of characters against a 1.0s source span: +100%, well
    // outside tolerance. The count is DERIVED from the rate rather than written
    // as a literal, because MEASURED_CHARS_PER_SEC stopped being a whole number
    // when Phase 3 measured it (12.72, not the estimated 13) and a test that
    // assumes an integer breaks on a voice change rather than on a real defect.
    const chars = Math.round(2 * MEASURED_CHARS_PER_SEC);
    const text = "क".repeat(chars);
    const report = measureDrift(
      [{ id: "s01", startSec: 0, endSec: 1 }],
      [{ id: "s01", targetText: text }]
    );

    expect(report.segments[0]?.chars).toBe(chars);
    expect(report.segments[0]?.estimatedTargetSec).toBeCloseTo(2, 1);
    expect(report.segments[0]?.ratio).toBeCloseTo(1, 1);
    expect(report.segments[0]?.overTolerance).toBe(true);
    expect(report.ratio).toBeCloseTo(1, 1);
    expect(report.overToleranceCount).toBe(1);
  });

  it("skips a source segment with no adapted counterpart rather than scoring it zero", () => {
    // Averaging a gap into a quality number is how a metric starts lying. The
    // adapt stage already fails loudly on a missing id; this must not quietly
    // report that the missing segment came in 100% short.
    const report = measureDrift(
      [
        { id: "s01", startSec: 0, endSec: 1 },
        { id: "s02", startSec: 1, endSec: 2 },
      ],
      [{ id: "s01", targetText: "क".repeat(Math.round(MEASURED_CHARS_PER_SEC)) }]
    );

    expect(report.segments).toHaveLength(1);
    // One second of speech against a one-second span. The assertion that matters
    // is that s02 contributed NOTHING: had it been scored as a zero-length
    // adaptation, the overall ratio would be about -50%, not about 0.
    expect(report.segments[0]?.id).toBe("s01");
    expect(report.ratio).toBeCloseTo(0, 1);
  });
});

describe("what each call is shown", () => {
  it("gives the brief call every segment's role, register and pace", () => {
    const text = formatAnalysisForBrief(
      analysis([
        analyzedSegment({ id: "s01" }),
        analyzedSegment({ id: "s02", signal: "warning" }),
      ])
    );

    expect(text).toContain("s01 — definition · neutral · slow");
    expect(text).toContain("s02 — warning");
    expect(text).toContain("Key terms: closure");
  });

  it("tells the first segment there is nothing before it", () => {
    const text = buildSegmentInput(brief(), analyzedSegment(), []);

    expect(text).toContain("this is the first segment");
    expect(text).toContain(LEAK.glossaryTarget);
  });

  it("carries every previously adapted segment's Hindi forward", () => {
    // Segment 11 can only match segment 3's wording if segment 3's words are in
    // front of it. This is the mechanism the sequential design exists for.
    const text = buildSegmentInput(brief(), analyzedSegment({ id: "s03" }), [
      adaptedSegment({ id: "s01", targetText: "पहला" }),
      adaptedSegment({ id: "s02", targetText: "दूसरा" }),
    ]);

    expect(text).toContain("s01: पहला");
    expect(text).toContain("s02: दूसरा");
    expect(text).toContain("Most recent segment (s02)");
  });

  it("states the id the model must return and the segment's length budget", () => {
    const text = buildSegmentInput(brief(), analyzedSegment({ id: "s07" }), []);

    expect(text).toContain("id: s07");
    expect(text).toContain(`about ${charBudget({ startSec: 0, endSec: 10 })} Devanagari`);
  });

  it("tells the model not to invent stress when the speaker was flat", () => {
    const text = buildSegmentInput(brief(), analyzedSegment({ emphasis: [] }), []);

    expect(text).toContain("Do not invent stress");
  });

  /**
   * The retry payload withholds the scores on purpose: a model told "you scored
   * 62" optimizes for a higher number, and there is no next attempt to score.
   * What it needs is the list of specific things that were wrong.
   */
  it("hands the retry the issues and the back-translation, but never the scores", () => {
    const text = formatCritiqueForRetry(
      segmentCritique({
        fidelity: 62,
        naturalness: 47,
        translationese: ["यह एक ऐसा है जो"],
        issues: ["the warning reads as a neutral statement"],
        suggestion: "open with a cautionary marker",
      })
    );

    expect(text).toContain("यह एक ऐसा है जो");
    expect(text).toContain("the warning reads as a neutral statement");
    expect(text).toContain("open with a cautionary marker");
    expect(text).not.toContain("62");
    expect(text).not.toContain("47");
  });

  it("leads the retry with the lost instructional move when that is what failed", () => {
    const text = formatCritiqueForRetry(segmentCritique({ signalPreserved: false }));

    expect(text).toContain("did NOT survive");
  });
});

describe("the Phase 2 schemas as a model contract", () => {
  /**
   * docs/SPEC.md section g lists "structured output rejects a deeply nested
   * schema" as a live risk, and names splitting Adapt as the mitigation. One
   * call per segment IS that split, so this asserts the property it bought:
   * every schema actually sent to the model stays shallow. Adaptation itself is
   * deeper and is exempt because no call ever returns it — it is assembled
   * locally from the parts below.
   */
  it("keeps every model-facing schema at most two objects deep", () => {
    for (const [name, schema] of Object.entries({
      AdaptationBrief,
      AdaptedSegment,
      Critique,
    })) {
      expect(
        depth(z.toJSONSchema(schema)),
        `${name} is nested too deeply`
      ).toBeLessThanOrEqual(2);
    }
  });

  it("round-trips a valid segment through JSON Schema conversion and parsing", () => {
    expect(() => z.toJSONSchema(AdaptedSegment)).not.toThrow();
    expect(AdaptedSegment.parse(adaptedSegment())).toEqual(adaptedSegment());
  });

  it("rejects a speaking rate outside what Chirp 3 HD is configured for", () => {
    expect(() =>
      AdaptedSegment.parse(
        adaptedSegment({
          ttsHints: { speakingRate: 1.9, pauseBefore: "none", style: "fast" },
        })
      )
    ).toThrow();
  });

  it("accepts a critique with no suggestion", () => {
    const parsed = Critique.parse(critique());

    expect(parsed.segments[0]?.suggestion).toBeUndefined();
  });

  it("parses a full Adaptation as the storage shape", () => {
    expect(Adaptation.parse(adaptation()).segments).toHaveLength(1);
  });
});

/** Nesting depth of an object schema, counting objects only — arrays are transparent. */
function depth(schema: unknown): number {
  if (typeof schema !== "object" || schema === null) return 0;

  const node = schema as {
    type?: string;
    properties?: Record<string, unknown>;
    items?: unknown;
  };

  if (node.type === "array") return depth(node.items);
  if (node.type !== "object" || node.properties === undefined) return 0;

  const children = Object.values(node.properties).map(depth);

  return 1 + Math.max(0, ...children);
}

describe("per-stage telemetry and thinking", () => {
  /**
   * The brief is one call over the whole clip; adapt is one call per segment.
   * Reporting both as "adapt" made them indistinguishable in Job.calls, which
   * SPEC section d's per-segment cost footer cannot render honestly — it would
   * bill a whole-clip call to whichever segment sorted first.
   */
  it("gives the brief its own telemetry stage, separate from adapt", () => {
    expect(ModelCallStage.options).toContain("brief");
    expect(ModelCallStage.options).toContain("adapt");
    expect(ModelCallStage.parse("brief")).toBe("brief");
  });

  it("keeps every stage the SPEC section b enum names", () => {
    expect(ModelCallStage.options).toEqual([
      "smoke",
      "analyze",
      "brief",
      "adapt",
      "critique",
      "adapt_retry",
      "synthesize",
    ]);
  });

  /**
   * docs/research.md § Thinking, DECIDED 2026-09-08 with numbers: critique at
   * `low` spends exactly 0 thought tokens and takes 7.7 s instead of 14.9 s,
   * with every score within 3 points and the same translationese quote on the
   * same segment. This asserts the decision is in the code and not only in the
   * document — which is the failure this test was written for.
   */
  it("defaults critique to the thinking level the measurement chose", () => {
    expect(CRITIQUE_THINKING_LEVEL).toBe("low");
  });
});
