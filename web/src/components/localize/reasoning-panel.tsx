"use client";

import { useState } from "react";
import { Check, Play, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type {
  AdaptedSegment,
  Adaptation,
  AnalyzedSegment,
  EmphasisCheck,
  ModelCall,
  SegmentCritique,
  SynthesizedSegment,
  SynthesizedUtterance,
} from "@/lib/api/schemas";
import { cn } from "@/lib/utils";
import { Highlight, type Mark } from "@/components/localize/highlight";
import {
  CHOICE_LABEL,
  SIGNAL_LABEL,
  SIGNAL_TONE,
  describeFit,
  describeTakes,
  formatTime,
} from "@/components/localize/format";

export interface OutputWindow {
  startSec: number;
  lengthSec: number;
  sourceStartSec: number;
  sourceEndSec: number;
}

export interface SegmentBundle {
  source: AnalyzedSegment;
  adapted: AdaptedSegment | undefined;
  critique: SegmentCritique | undefined;
  synth: SynthesizedSegment | undefined;
  /** The TTS call this segment was spoken in. Undefined on jobs from before 2026-10-01. */
  utterance: SynthesizedUtterance | undefined;
  /**
   * The stretch of output.mp3 that voices this segment, and the source stretch
   * it covers. On newer jobs that is the whole utterance — a segment spoken
   * mid-sentence has no audio boundary of its own to seek to.
   */
  output: OutputWindow | undefined;
  checks: EmphasisCheck[];
  retried: boolean;
  /** The calls that produced THIS segment's adaptation (adapt, and a retry). */
  ownCalls: ModelCall[];
  /** Whole-clip calls (analyze, brief, critique) that every segment shares. */
  sharedCalls: ModelCall[];
}

const VERDICT_TEXT: Record<EmphasisCheck["verdict"], string> = {
  supported: "measurement supports it",
  unsupported: "no supporting measurement",
  not_measurable: "span too short to measure",
};

/**
 * ============================================================================
 * The reasoning panel — docs/SPEC.md section d, items 1-7, top to bottom.
 * ============================================================================
 *
 * Everything here is data already in the Job; the panel makes no calls. Its
 * one rule is the project's: show the misses. A segment regenerated after the
 * critique says the scores are for the draft it replaced; a stressed term the
 * voice did nothing for is still highlighted and says "not voiced"; an emphasis
 * claim measurement does not back says so beside the model's own evidence.
 */
export function ReasoningPanel({
  bundle,
  glossary,
  onPlay,
}: {
  bundle: SegmentBundle;
  glossary: Adaptation["brief"]["glossary"];
  onPlay: (which: "source" | "output") => void;
}) {
  const { source, adapted, critique, synth, utterance, checks, retried } = bundle;
  const [showLiteral, setShowLiteral] = useState(false);
  const takes = utterance === undefined ? null : describeTakes(utterance);

  const sourceMarks: Mark[] = source.emphasis.map((marker) => {
    const check = checks.find((entry) => entry.term === marker.term);
    return {
      term: marker.term,
      title:
        `${marker.strength} stress — model: "${marker.evidence}"` +
        (check === undefined
          ? ""
          : `\nffmpeg: ${check.measurement} (${VERDICT_TEXT[check.verdict]})`),
    };
  });

  const targetMarks: Mark[] = (adapted?.emphasisTerms ?? []).map((term) => {
    if (synth?.emphasisPausedTerm === term) {
      return { term, title: "Voiced: a short pause before this word" };
    }
    if (synth?.emphasisNotFound.includes(term)) {
      return {
        term,
        title: "Claimed for stress but not in this Hindi text",
        className: "bg-red-200/60 dark:bg-red-500/30",
      };
    }
    // Only a voice that takes no direction leaves a term unvoiced (the Chirp
    // fallback); a directed voice was asked to lean on it.
    if (synth !== undefined && !synth.emphasisNotRealized.includes(term)) {
      return { term, title: "Voiced: the voice was asked to lean on this word" };
    }
    return {
      term,
      title: "Highlighted, not voiced: this voice cannot stress individual words",
      className: "bg-muted decoration-muted-foreground",
    };
  });

  const glossaryUsed = glossary.filter((entry) =>
    (adapted?.termsUsed ?? []).includes(entry.english)
  );

  return (
    <div className="grid gap-5 text-sm">
      {/* 1. Signal header */}
      <section className="grid gap-2" aria-label="Instructional signal">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-md px-2 py-0.5 text-xs font-medium",
              SIGNAL_TONE[source.signal]
            )}
          >
            {SIGNAL_LABEL[source.signal]} · {Math.round(source.signalConfidence * 100)}%
          </span>
          <Badge variant="outline">{source.register}</Badge>
          <Badge variant="outline">{source.pace} pace</Badge>
          <span className="text-xs tabular-nums text-muted-foreground">
            {source.id} · {formatTime(source.startSec)}–{formatTime(source.endSec)}
          </span>
        </div>
        <p className="text-muted-foreground">{source.signalEvidence}</p>
      </section>

      {/* 2. Original */}
      <Block
        title="What the teacher said"
        action={<PlayButton label="Play English" onClick={() => onPlay("source")} />}
      >
        <p className="leading-relaxed">
          <Highlight text={source.text} marks={sourceMarks} />
        </p>
        {checks.length > 0 ? (
          <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
            {checks.map((check, index) => (
              <li key={`${index}-${check.term}`}>
                <span className="font-medium text-foreground">{check.term}</span> — model
                heard: &ldquo;{check.modelEvidence}&rdquo;; ffmpeg measured:{" "}
                {check.measurement} <VerdictTag verdict={check.verdict} />
              </li>
            ))}
          </ul>
        ) : null}
        {source.idioms.length > 0 ? (
          <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
            {source.idioms.map((idiom, index) => (
              <li key={`${index}-${idiom.phrase}`}>
                <span className="font-medium text-foreground">
                  &ldquo;{idiom.phrase}&rdquo;
                </span>{" "}
                ({idiom.kind}) literally &ldquo;{idiom.literalMeaning}&rdquo;, meant
                &ldquo;
                {idiom.intendedMeaning}&rdquo;
              </li>
            ))}
          </ul>
        ) : null}
      </Block>

      {/* 3. Adapted */}
      {adapted === undefined ? (
        <Pending what="Hindi adaptation" />
      ) : (
        <Block
          title="What the learner hears"
          action={
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={showLiteral}
                onClick={() => setShowLiteral((value) => !value)}
              >
                {showLiteral ? "Hide" : "Compare with"} literal
              </Button>
              {bundle.output === undefined ? null : (
                <PlayButton label="Play Hindi" onClick={() => onPlay("output")} />
              )}
            </div>
          }
        >
          <p lang="hi" className="text-base leading-relaxed">
            <Highlight text={adapted.targetText} marks={targetMarks} />
          </p>
          {showLiteral ? (
            <p lang="hi" className="mt-2 border-l-2 pl-3 text-muted-foreground">
              <span className="block text-xs font-medium" lang="en">
                A word-for-word translation would say
              </span>
              {adapted.literalText}
            </p>
          ) : null}
        </Block>
      )}

      {/* 4. Why */}
      {adapted === undefined ? null : (
        <Block title="Why it says it this way">
          <p className="leading-relaxed">{adapted.rationale}</p>
          {adapted.choices.length > 0 ? (
            <ul className="mt-3 grid gap-2">
              {adapted.choices.map((choice, index) => (
                <li key={index} className="rounded-md border p-3">
                  <div className="text-xs font-medium text-muted-foreground">
                    {CHOICE_LABEL[choice.kind]}
                  </div>
                  <div className="mt-1">
                    &ldquo;{choice.original}&rdquo; →{" "}
                    <span lang="hi">&ldquo;{choice.adapted}&rdquo;</span>
                  </div>
                  <p className="mt-1 text-muted-foreground">{choice.why}</p>
                </li>
              ))}
            </ul>
          ) : null}
          {glossaryUsed.length > 0 ? (
            <div className="mt-3 text-xs text-muted-foreground">
              Glossary terms, fixed for the whole clip:{" "}
              {glossaryUsed.map((entry, index) => (
                <span key={`${index}-${entry.english}`} title={entry.why}>
                  {index > 0 ? ", " : ""}
                  <span className="text-foreground">{entry.english}</span> →{" "}
                  <span lang="hi">{entry.targetForm}</span>
                </span>
              ))}
            </div>
          ) : null}
        </Block>
      )}

      {/* 5. Check */}
      {critique === undefined ? (
        <Pending what="blind critique" />
      ) : (
        <Block title="Checked by a critic that never saw the reasoning">
          {retried ? (
            <p className="mb-2 flex items-start gap-2 rounded-md bg-amber-500/10 p-2 text-xs">
              <RotateCcw className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Regenerated after critique. The scores below are for the FIRST draft, which
              failed the gate; the Hindi above is the one retry, kept regardless.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            The Hindi, read back into English:
          </p>
          <p className="mt-1 italic leading-relaxed">
            &ldquo;{critique.backTranslation}&rdquo;
          </p>
          <div className="mt-3 grid gap-2">
            <ScoreBar
              label="Fidelity — still teaches the same thing"
              value={critique.fidelity}
            />
            <ScoreBar
              label="Naturalness — sounds spoken, not translated"
              value={critique.naturalness}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-xs">
            <Tick ok={critique.signalPreserved} label="Instructional move preserved" />
            <Tick ok={critique.emphasisPreserved} label="Stressed terms preserved" />
          </div>
          {critique.translationese.length > 0 ? (
            <div className="mt-3 text-xs">
              <div className="font-medium">Stiff constructions quoted by the critic</div>
              <ul className="mt-1 grid gap-1" lang="hi">
                {critique.translationese.map((quote, index) => (
                  <li key={`${index}-${quote}`}>&ldquo;{quote}&rdquo;</li>
                ))}
              </ul>
            </div>
          ) : null}
          {critique.issues.length > 0 ? (
            <ul className="mt-3 list-disc pl-5 text-xs text-muted-foreground">
              {critique.issues.map((issue, index) => (
                <li key={`${index}-${issue}`}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </Block>
      )}

      {/* 6. Voice */}
      {synth === undefined ? (
        <Pending what="synthesized audio" />
      ) : (
        <Block title="How it was voiced">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Voice</dt>
            <dd>{synth.voice}</dd>
            <dt className="text-muted-foreground">Speaking rate</dt>
            <dd className="tabular-nums">{synth.speakingRate.toFixed(2)}</dd>
            <dt className="text-muted-foreground">Lead pause</dt>
            <dd className="tabular-nums">{synth.pauseBeforeMs} ms</dd>
            {utterance === undefined ? (
              <>
                <dt className="text-muted-foreground">Pause before</dt>
                <dd lang="hi">{synth.emphasisPausedTerm ?? "—"}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Not voiced</dt>
            <dd lang="hi">
              {synth.emphasisNotRealized.length > 0
                ? synth.emphasisNotRealized.join(", ")
                : "—"}
            </dd>
            {utterance === undefined ? (
              synth.measuredDurationSec === undefined ? null : (
                <>
                  <dt className="text-muted-foreground">Measured</dt>
                  <dd className="tabular-nums">
                    {synth.measuredDurationSec.toFixed(2)} s for a{" "}
                    {(source.endSec - source.startSec).toFixed(2)} s source span
                  </dd>
                </>
              )
            ) : (
              <>
                {utterance.segmentIds.length > 1 ? (
                  <>
                    <dt className="text-muted-foreground">Spoken with</dt>
                    <dd>
                      {utterance.segmentIds.filter((id) => id !== source.id).join(", ")}{" "}
                      <span className="text-muted-foreground">
                        in one breath, so the sentence is not cut
                      </span>
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Measured</dt>
                <dd className="tabular-nums">
                  {utterance.measuredDurationSec.toFixed(2)} s at{" "}
                  {formatTime(utterance.outputStartSec)}, for{" "}
                  {(utterance.deadlineSec - utterance.sourceStartSec).toFixed(2)} s of
                  source time
                </dd>
                {utterance.pace === undefined ? null : (
                  <>
                    <dt className="text-muted-foreground">Pace asked for</dt>
                    <dd className="tabular-nums">
                      {utterance.pace}
                      {utterance.speechSec === undefined
                        ? null
                        : ` — the teacher speaks for ${utterance.speechSec.toFixed(1)} s here`}
                    </dd>
                  </>
                )}
                {takes === null ? null : (
                  <>
                    <dt className="text-muted-foreground">Takes</dt>
                    <dd className="tabular-nums">{takes}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Fit</dt>
                <dd className="tabular-nums">{describeFit(utterance)}</dd>
              </>
            )}
          </dl>
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Exactly what the voice was given to say
            </summary>
            <pre
              className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2"
              lang="hi"
            >
              {synth.markupUsed}
            </pre>
          </details>
        </Block>
      )}

      {/* 7. Footer — the cost of this reasoning */}
      <Separator />
      <footer className="grid gap-1 text-xs text-muted-foreground">
        {bundle.ownCalls.map((call, index) => (
          <CallLine key={index} call={call} />
        ))}
        {utterance !== undefined ? (
          <div>
            tts · {utterance.billedChars} billed chars ·{" "}
            {(utterance.latencyMs / 1000).toFixed(1)} s
            {utterance.segmentIds.length > 1 ? " (shared utterance)" : ""}
          </div>
        ) : synth?.billedChars !== undefined && synth.latencyMs !== undefined ? (
          <div>
            tts · {synth.billedChars} billed chars · {(synth.latencyMs / 1000).toFixed(1)}{" "}
            s
          </div>
        ) : null}
        {bundle.sharedCalls.length > 0 ? (
          <details>
            <summary className="cursor-pointer">
              Whole-clip calls this segment shares
            </summary>
            {bundle.sharedCalls.map((call, index) => (
              <CallLine key={index} call={call} />
            ))}
          </details>
        ) : null}
      </footer>
    </div>
  );
}

function Block({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </div>
      <div>{children}</div>
    </section>
  );
}

function Pending({ what }: { what: string }) {
  return <p className="text-xs text-muted-foreground">Waiting for the {what}…</p>;
}

function PlayButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <Play className="size-3.5" aria-hidden />
      {label}
    </Button>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid gap-1">
      <div className="flex justify-between text-xs">
        <span>{label}</span>
        <span className="tabular-nums font-medium">{value}</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <div
          className={cn(
            "h-full rounded-full",
            value < 70 ? "bg-destructive" : value < 85 ? "bg-amber-500" : "bg-emerald-500"
          )}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

function Tick({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {ok ? (
        <Check className="size-3.5 text-emerald-600" aria-hidden />
      ) : (
        <X className="size-3.5 text-destructive" aria-hidden />
      )}
      {label}
      <span className="sr-only">{ok ? "yes" : "no"}</span>
    </span>
  );
}

function VerdictTag({ verdict }: { verdict: EmphasisCheck["verdict"] }) {
  return (
    <span
      className={cn(
        "rounded px-1",
        verdict === "supported" &&
          "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        verdict === "unsupported" && "bg-muted",
        verdict === "not_measurable" && "bg-muted"
      )}
    >
      {VERDICT_TEXT[verdict]}
    </span>
  );
}

function CallLine({ call }: { call: ModelCall }) {
  return (
    <div className="tabular-nums">
      {call.stage} · {call.inputTokens.toLocaleString()} in /{" "}
      {call.outputTokens.toLocaleString()} out / {call.thoughtTokens.toLocaleString()}{" "}
      thinking · {(call.latencyMs / 1000).toFixed(1)} s
    </div>
  );
}
