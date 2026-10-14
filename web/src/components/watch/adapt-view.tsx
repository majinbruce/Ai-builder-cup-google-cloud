import { useState } from "react";
import { Play } from "lucide-react";
import type { SegmentBundle } from "@/components/watch/bundle";
import { DECISION_LABEL } from "@/components/watch/lesson-layers";
import { Highlight, type Mark } from "@/components/localize/highlight";
import { STEPS } from "@/components/landing/process-section";
import {
  CHOICE_LABEL,
  SIGNAL_COLOR,
  SIGNAL_LABEL,
  describeFit,
  describeTakes,
  formatTime,
} from "@/components/localize/format";
import type { Adaptation, EmphasisCheck, ModelCall, Speaker } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

type Brief = Adaptation["brief"];

const VERDICT: Record<EmphasisCheck["verdict"], { text: string; color: string }> = {
  supported: { text: "Measurement supports it", color: "#bfc26a" },
  unsupported: { text: "Not confirmed by measurement", color: "#fab0a1" },
  not_measurable: { text: "Too short to measure", color: "rgb(255 231 206 / 40%)" },
};

/**
 * "Five steps, one segment": pick a segment from the strip, then a step, and
 * see what that step did to that segment and why. Everything is the job's own
 * data; the one rule is the project's: show the misses. A rewritten segment
 * says its scores are for the draft that failed, a stress claim measurement
 * does not back says so beside the model's evidence, and a stressed word the
 * voice did nothing for says "not voiced".
 */
export function AdaptView({
  segments,
  selectedIndex,
  onSelect,
  brief,
  speakers,
  onPlay,
  footer,
}: {
  segments: SegmentBundle[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  brief: Brief | null;
  speakers: Speaker[];
  onPlay: (entry: SegmentBundle, which: "source" | "output") => void;
  footer: React.ReactNode;
}) {
  const [stage, setStage] = useState(2);
  const selected = segments[selectedIndex];
  const step = STEPS[stage] ?? STEPS[0];
  if (selected === undefined) return null;

  const next = segments[selectedIndex + 1]?.source.startSec ?? selected.source.endSec;

  return (
    <div className="mx-(--gutter) animate-[nua-in_.45s_cubic-bezier(.2,.7,.2,1)_both]">
      <div
        role="tablist"
        aria-label="Segments"
        className="flex h-[84px] items-start gap-[3px]"
        onKeyDown={(event) => {
          const delta =
            event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          const target = selectedIndex + delta;
          if (delta === 0 || target < 0 || target >= segments.length) return;
          event.preventDefault();
          onSelect(target);
          (event.currentTarget.children[target] as HTMLElement | undefined)?.focus();
        }}
      >
        {segments.map((entry, index) => {
          const on = index === selectedIndex;
          const end = segments[index + 1]?.source.startSec ?? entry.source.endSec;
          return (
            <button
              key={entry.source.id}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onSelect(index)}
              aria-label={`Segment ${index + 1}, ${SIGNAL_LABEL[entry.source.signal]}, ${formatTime(entry.source.startSec)}${entry.retried ? ", rewritten after critique" : ""}`}
              className="flex min-w-0 flex-col gap-2.5 nua-focus"
              style={{ flex: `${Math.max(0.1, end - entry.source.startSec)} 1 0px` }}
            >
              <span
                className="block transition-[height,margin] duration-200"
                style={{
                  height: on ? 44 : 32,
                  marginTop: on ? 0 : 12,
                  background: SIGNAL_COLOR[entry.source.signal],
                }}
              />
              <span
                className={cn(
                  "flex items-center gap-1.5 overflow-hidden border-t pt-2 text-[13px] whitespace-nowrap",
                  on ? "border-cream text-cream" : "border-transparent text-cream/45"
                )}
              >
                <span className="font-medium">{index + 1}</span>
                {end - entry.source.startSec < 4 ? null : (
                  <span className="hidden tabular-nums md:inline">
                    {formatTime(entry.source.startSec)}
                  </span>
                )}
                {entry.retried ? <span className="text-blush">↻</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-2.5 flex flex-wrap justify-between gap-2 text-[13px] text-cream/55">
        <span>
          Segment {selectedIndex + 1} of {segments.length} ·{" "}
          {SIGNAL_LABEL[selected.source.signal]} · {selected.source.id} ·{" "}
          {formatTime(selected.source.startSec)}–{formatTime(next)}
        </span>
        <span>↻ rewritten after critique</span>
      </div>

      <div
        role="tablist"
        aria-label="Steps"
        className="mt-10 grid grid-cols-5 gap-[max(8px,1.5vw)]"
      >
        {STEPS.map((item, index) => (
          <button
            key={item.title}
            type="button"
            role="tab"
            aria-selected={index === stage}
            onClick={() => setStage(index)}
            className={cn(
              "nua-caps overflow-hidden border-b pb-3 text-left text-[max(11px,0.95vw)] text-ellipsis whitespace-nowrap transition-colors hover:text-cream nua-focus",
              index === stage
                ? "border-cream text-cream"
                : "border-cream/14 text-cream/32"
            )}
          >
            0{index + 1} {item.title}
          </button>
        ))}
      </div>

      <div className="mt-6 grid min-h-[440px] md:grid-cols-2">
        <div className="flex flex-col gap-4 bg-panel p-[max(20px,2.2vw)]">
          <h3 className="text-[32px] font-medium tracking-[-0.02em]">{step.title}</h3>
          <p className="text-[16px] leading-normal text-pretty text-stone">{step.desc}</p>
          <p className="mt-auto border border-cream/30 p-4 text-[15px] leading-normal text-pretty">
            {step.note}
          </p>
        </div>
        <div
          key={`${selected.source.id}-${stage}`}
          className="flex animate-[nua-in_.35s_ease_both] flex-col gap-[18px] bg-panel-2 p-[max(20px,2.2vw)]"
        >
          {stage === 0 ? (
            <Listen entry={selected} speakers={speakers} onPlay={onPlay} />
          ) : stage === 1 ? (
            <Plan entry={selected} brief={brief} />
          ) : stage === 2 ? (
            <Reteach entry={selected} />
          ) : stage === 3 ? (
            <Grade entry={selected} />
          ) : (
            <Speak entry={selected} onPlay={onPlay} />
          )}
        </div>
      </div>
      {footer}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="nua-label">{children}</span>;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-[7px] border border-cream/30 px-2.5 py-1">
      {children}
    </span>
  );
}

function PlayButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 items-center gap-1.5 border border-cream/40 px-3 text-[13px] transition-colors hover:bg-cream hover:text-ink nua-focus"
    >
      <Play className="size-3" aria-hidden /> {label}
    </button>
  );
}

function Pending({ what }: { what: string }) {
  return <p className="text-[14px] text-stone">Waiting for the {what}…</p>;
}

function Listen({
  entry,
  speakers,
  onPlay,
}: {
  entry: SegmentBundle;
  speakers: Speaker[];
  onPlay: (entry: SegmentBundle, which: "source" | "output") => void;
}) {
  const { source, checks } = entry;
  const speaker =
    speakers.length > 1 ? speakers.find((s) => s.id === source.speaker) : undefined;
  const marks: Mark[] = source.emphasis.map((marker) => {
    const check = checks.find((c) => c.term === marker.term);
    return {
      term: marker.term,
      title:
        `${marker.strength} stress — model: "${marker.evidence}"` +
        (check === undefined ? "" : `\nffmpeg: ${check.measurement}`),
    };
  });

  return (
    <>
      <div className="flex flex-wrap gap-2 text-[13px]">
        <Chip>
          <span
            className="size-[9px]"
            style={{ background: SIGNAL_COLOR[source.signal] }}
          />
          {SIGNAL_LABEL[source.signal]} · {Math.round(source.signalConfidence * 100)}%
          sure
        </Chip>
        <Chip>{source.register}</Chip>
        <Chip>{source.pace} pace</Chip>
        {speaker === undefined ? null : <Chip>{speaker.description}</Chip>}
      </div>
      <p className="font-serif text-[22px] leading-[1.4] italic">
        {source.signalEvidence}
      </p>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label>What the teacher said</Label>
          <PlayButton label="Play English" onClick={() => onPlay(entry, "source")} />
        </div>
        <p className="text-[17px] leading-normal">
          <Highlight text={source.text} marks={marks} />
        </p>
      </div>
      {checks.length > 0 ? (
        <div className="flex flex-col gap-[3px]">
          {checks.map((check, index) => (
            <div
              key={`${index}-${check.term}`}
              className="flex flex-col gap-1.5 bg-ink p-3.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] font-medium">Stress on “{check.term}”</span>
                <span
                  className="px-2 py-0.5 text-[12px] text-ink"
                  style={{ background: VERDICT[check.verdict].color }}
                >
                  {VERDICT[check.verdict].text}
                </span>
              </div>
              <span className="text-[14px] leading-[1.45] text-stone">
                <span className="text-cream">Model heard:</span> {check.modelEvidence}
              </span>
              <span className="text-[14px] leading-[1.45] text-stone">
                <span className="text-cream">ffmpeg measured:</span> {check.measurement}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {source.idioms.length > 0 ? (
        <ul className="flex flex-col gap-1 text-[13px] text-stone">
          {source.idioms.map((idiom, index) => (
            <li key={`${index}-${idiom.phrase}`}>
              <span className="text-cream">“{idiom.phrase}”</span> (
              {idiom.kind.replace("_", " ")}) literally “{idiom.literalMeaning}”, meant “
              {idiom.intendedMeaning}”
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function Plan({ entry, brief }: { entry: SegmentBundle; brief: Brief | null }) {
  if (brief === null) return <Pending what="brief" />;
  const used = brief.glossary.filter((g) =>
    (entry.adapted?.termsUsed ?? []).includes(g.english)
  );
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label>The teacher</Label>
        <p className="text-[15px] leading-normal">{brief.instructorPersona}</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label>How the Hindi should sound</Label>
        <p className="text-[15px] leading-normal">{brief.registerGuidance}</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label>Glossary terms in this segment</Label>
        {used.length === 0 ? (
          <span className="text-[14px] text-stone">
            This segment uses none of the glossary.
          </span>
        ) : (
          used.map((term, index) => (
            <div
              key={`${index}-${term.english}`}
              className="flex flex-col gap-1 border-t border-cream/10 py-2"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[15px]">
                  {term.english} →{" "}
                  <span lang="hi" className="text-[18px]">
                    {term.targetForm}
                  </span>
                </span>
                <span className="text-[12px] whitespace-nowrap text-cream/50">
                  {DECISION_LABEL[term.decision]}
                </span>
              </div>
              <span className="text-[13px] text-stone">{term.why}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function Reteach({ entry }: { entry: SegmentBundle }) {
  const { adapted } = entry;
  if (adapted === undefined) return <Pending what="Hindi adaptation" />;
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label>Literal translation</Label>
        <p lang="hi" className="text-[17px] leading-[1.55] text-stone">
          {adapted.literalText}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label>What Nua says</Label>
        <p lang="hi" className="text-[21px] leading-[1.55]">
          <Highlight
            text={adapted.targetText}
            marks={adapted.emphasisTerms.map((term) => ({
              term,
              title: "Stressed in the Hindi too",
            }))}
          />
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label>Why it says it this way</Label>
        <p className="text-[15px] leading-normal">{adapted.rationale}</p>
      </div>
      {adapted.choices.length > 0 ? (
        <div className="flex flex-col gap-[3px]">
          {adapted.choices.map((choice, index) => (
            <div
              key={index}
              className="grid gap-3 bg-ink px-3.5 py-3 sm:grid-cols-[120px_minmax(0,1fr)]"
            >
              <span className="text-[12px] text-gloss">{CHOICE_LABEL[choice.kind]}</span>
              <span className="flex flex-col gap-1">
                <span className="text-[16px]">
                  <span className="text-stone line-through">{choice.original}</span> →{" "}
                  <span lang="hi">{choice.adapted}</span>
                </span>
                <span className="text-[13px] text-stone">{choice.why}</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function Grade({ entry }: { entry: SegmentBundle }) {
  const { critique, retried } = entry;
  if (critique === undefined) return <Pending what="blind critique" />;
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label>A separate critic, blind to the reasoning, read the Hindi back as</Label>
        <p className="font-serif text-[22px] leading-[1.4] italic">
          “{critique.backTranslation}”
        </p>
      </div>
      <div className="grid grid-cols-2 gap-6">
        <Score label="Fidelity" value={critique.fidelity} />
        <Score label="Naturalness" value={critique.naturalness} />
      </div>
      <span className={cn("text-[15px]", retried ? "text-blush" : "text-stone")}>
        {retried
          ? "↻ The first draft scored under 70 and was rewritten once. These scores are for that failed draft; the Hindi shown is the rewrite, kept regardless."
          : "Passed on the first draft."}
      </span>
      <div className="flex flex-wrap gap-4 text-[13px]">
        <span>{critique.signalPreserved ? "✓" : "✗"} Instructional move preserved</span>
        <span>{critique.emphasisPreserved ? "✓" : "✗"} Stressed terms preserved</span>
      </div>
      {critique.translationese.length > 0 ? (
        <div className="flex flex-col gap-1 text-[13px]">
          <Label>Stiff constructions quoted by the critic</Label>
          {critique.translationese.map((quote, index) => (
            <span key={`${index}-${quote}`} lang="hi">
              “{quote}”
            </span>
          ))}
        </div>
      ) : null}
      {critique.issues.length > 0 ? (
        <ul className="list-disc pl-5 text-[13px] text-stone">
          {critique.issues.map((issue, index) => (
            <li key={`${index}-${issue}`}>{issue}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function Score({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-t border-cream pt-2.5">
      <span className="nua-caps text-[12px]">{label}</span>
      <div
        className={cn(
          "nua-display mt-1.5 text-[80px] leading-none",
          value < 70 && "text-blush"
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Speak({
  entry,
  onPlay,
}: {
  entry: SegmentBundle;
  onPlay: (entry: SegmentBundle, which: "source" | "output") => void;
}) {
  const { adapted, synth, utterance, source } = entry;
  if (adapted === undefined || synth === undefined)
    return <Pending what="synthesized audio" />;
  const takes = utterance === undefined ? null : describeTakes(utterance);

  const status = (term: string) => {
    if (synth.emphasisPausedTerm === term) return "Voiced: a short pause before it";
    if (synth.emphasisNotFound.includes(term))
      return "Claimed for stress, but not in this Hindi";
    // Only a voice that takes no direction leaves a term unvoiced (the Chirp
    // fallback); a directed voice was asked to lean on it.
    if (!synth.emphasisNotRealized.includes(term))
      return "Voiced: the voice was asked to lean on it";
    return "Not voiced: this voice cannot stress single words";
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <Label>What the learner hears</Label>
        {entry.output === undefined ? null : (
          <PlayButton label="Play Hindi" onClick={() => onPlay(entry, "output")} />
        )}
      </div>
      <p lang="hi" className="text-[22px] leading-[1.6]">
        <Highlight
          text={adapted.targetText}
          marks={adapted.emphasisTerms.map((term) => ({
            term,
            title: status(term),
            className: "bg-gloss text-ink no-underline px-0.5",
          }))}
        />
      </p>
      {adapted.emphasisTerms.length > 0 ? (
        <div className="flex flex-col gap-[3px]">
          {adapted.emphasisTerms.map((term) => (
            <div
              key={term}
              className="flex flex-wrap items-center justify-between gap-2 bg-ink px-3.5 py-2.5"
            >
              <span lang="hi" className="text-[16px]">
                {term}
              </span>
              <span className="text-[13px] text-stone">{status(term)}</span>
            </div>
          ))}
        </div>
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
        <dt className="text-cream/50">Voice</dt>
        <dd>{synth.voice}</dd>
        {utterance === undefined ? (
          synth.measuredDurationSec === undefined ? null : (
            <>
              <dt className="text-cream/50">Measured</dt>
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
                <dt className="text-cream/50">Spoken with</dt>
                <dd>
                  {utterance.segmentIds.filter((id) => id !== source.id).join(", ")}, in
                  one breath, so the sentence is not cut
                </dd>
              </>
            ) : null}
            <dt className="text-cream/50">Measured</dt>
            <dd className="tabular-nums">
              {utterance.measuredDurationSec.toFixed(2)} s at{" "}
              {formatTime(utterance.outputStartSec)}, for{" "}
              {(utterance.deadlineSec - utterance.sourceStartSec).toFixed(2)} s of source
              time
            </dd>
            {utterance.pace === undefined ? null : (
              <>
                <dt className="text-cream/50">Pace asked for</dt>
                <dd className="tabular-nums">
                  {utterance.pace}
                  {utterance.speechSec === undefined
                    ? null
                    : `; the teacher speaks for ${utterance.speechSec.toFixed(1)} s here`}
                </dd>
              </>
            )}
            {takes === null ? null : (
              <>
                <dt className="text-cream/50">Takes</dt>
                <dd className="tabular-nums">{takes}</dd>
              </>
            )}
            <dt className="text-cream/50">Fit</dt>
            <dd className="tabular-nums">{describeFit(utterance)}</dd>
          </>
        )}
      </dl>
      <details className="text-[13px]">
        <summary className="cursor-pointer text-cream/62 hover:text-cream">
          Exactly what the voice was given
        </summary>
        <pre
          lang="hi"
          className="mt-2 overflow-x-auto bg-ink p-3 font-mono text-[12px] break-words whitespace-pre-wrap"
        >
          {utterance?.markupUsed ?? synth.markupUsed}
        </pre>
      </details>
      <CallCosts entry={entry} />
    </>
  );
}

function CallLine({ call }: { call: ModelCall }) {
  return (
    <div className="tabular-nums">
      {call.stage.replace("_", " ")} · {call.inputTokens.toLocaleString()} in /{" "}
      {call.outputTokens.toLocaleString()} out / {call.thoughtTokens.toLocaleString()}{" "}
      thinking · {(call.latencyMs / 1000).toFixed(1)} s
    </div>
  );
}

/** What this segment's reasoning cost: its own calls, the shared ones, and the voice. */
function CallCosts({ entry }: { entry: SegmentBundle }) {
  const { utterance, synth } = entry;
  return (
    <div className="flex flex-col gap-1 border-t border-cream/10 pt-3 text-[12px] text-cream/50">
      {entry.ownCalls.map((call, index) => (
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
          tts · {synth.billedChars} billed chars · {(synth.latencyMs / 1000).toFixed(1)} s
        </div>
      ) : null}
      {entry.sharedCalls.length > 0 ? (
        <details>
          <summary className="cursor-pointer hover:text-cream">
            Whole-clip calls this segment shares
          </summary>
          {entry.sharedCalls.map((call, index) => (
            <CallLine key={index} call={call} />
          ))}
        </details>
      ) : null}
    </div>
  );
}
