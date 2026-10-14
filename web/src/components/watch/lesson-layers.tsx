import { useState } from "react";
import type { SegmentBundle } from "@/components/watch/bundle";
import { SIGNAL_COLOR, SIGNAL_LABEL, formatTime } from "@/components/localize/format";
import type { Adaptation } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

type GlossaryEntry = Adaptation["brief"]["glossary"][number];

export const DECISION_LABEL: Record<GlossaryEntry["decision"], string> = {
  transliterate: "Transliterated",
  translate: "Translated",
  keep_english_concept: "Kept as English",
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Splits Hindi text into runs, marking each glossary term by its index. */
function glossaryRuns(text: string, glossary: GlossaryEntry[]) {
  const forms = glossary
    .map((entry, index) => ({ form: entry.targetForm.trim(), index }))
    .filter((entry) => entry.form !== "")
    .sort((a, b) => b.form.length - a.form.length);
  if (forms.length === 0) return [{ text, index: -1 }];
  const pattern = new RegExp(
    `(${forms.map((f) => escapeRegExp(f.form)).join("|")})`,
    "g"
  );
  return text
    .split(pattern)
    .filter((part) => part !== "")
    .map((part) => ({
      text: part,
      index: forms.find((f) => f.form === part)?.index ?? -1,
    }));
}

/** Where each glossary term is first said, in source time, or null. */
function firstSaid(entry: GlossaryEntry, segments: SegmentBundle[]): number | null {
  const english = entry.english.toLowerCase();
  const hit =
    segments.find((s) => s.adapted?.termsUsed.includes(entry.english)) ??
    segments.find((s) => s.source.text.toLowerCase().includes(english));
  return hit?.source.startSec ?? null;
}

/**
 * "The lesson, in two layers": every segment's Hindi over its English (or
 * either alone), with the glossary's terms picked out in yellow; beside it the
 * glossary itself, fixed for the whole clip. A term opens its reasoning; its
 * time plays from where it is first said.
 */
export function LessonLayers({
  segments,
  glossary,
  playingId,
  onJump,
  onSeek,
}: {
  segments: SegmentBundle[];
  glossary: GlossaryEntry[];
  playingId: string | null;
  onJump: (entry: SegmentBundle) => void;
  onSeek: (sourceSec: number) => void;
}) {
  const [layer, setLayer] = useState<"hi" | "en" | "both">("both");
  const [open, setOpen] = useState<number>(-1);
  const kinds = [...new Set(segments.map((s) => s.source.signal))];

  return (
    <div className="mx-(--gutter) animate-[nua-in_.45s_cubic-bezier(.2,.7,.2,1)_both]">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <ul className="flex flex-wrap gap-5 text-[13px]">
          {kinds.map((signal) => (
            <li key={signal} className="flex items-center gap-2">
              <span className="size-[9px]" style={{ background: SIGNAL_COLOR[signal] }} />
              {SIGNAL_LABEL[signal]}
            </li>
          ))}
        </ul>
        <div role="group" aria-label="Show" className="flex gap-2.5">
          {(
            [
              ["hi", "Hindi"],
              ["en", "English"],
              ["both", "Both"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={layer === key}
              onClick={() => setLayer(key)}
              className="nua-btn nua-btn-outline h-10"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {glossary.length > 0 && layer !== "en" ? (
        <p className="mt-3.5 text-[13px] text-cream/62">
          <span className="text-gloss">Yellow words</span> are glossary terms. Select one
          to open it.
        </p>
      ) : null}

      <div className="mt-6 grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)]">
        <ol className="flex flex-col gap-[3px]" aria-label="Lesson transcript">
          {segments.map((entry) => {
            const playing = entry.source.id === playingId;
            const hindi = entry.adapted?.targetText;
            return (
              <li
                key={entry.source.id}
                className={cn(
                  "grid gap-5 p-[22px] transition-colors duration-200 sm:grid-cols-[96px_minmax(0,1fr)]",
                  playing && "bg-panel-2"
                )}
              >
                <div className="flex flex-col gap-2.5 text-[13px]">
                  <button
                    type="button"
                    onClick={() => onJump(entry)}
                    className="self-start text-cream/55 tabular-nums hover:text-cream nua-focus"
                    aria-label={`Play from ${formatTime(entry.source.startSec)}`}
                  >
                    {formatTime(entry.source.startSec)}
                  </button>
                  <span className="flex items-center gap-[7px]">
                    <span
                      className="size-[9px] shrink-0"
                      style={{ background: SIGNAL_COLOR[entry.source.signal] }}
                    />
                    {SIGNAL_LABEL[entry.source.signal]}
                  </span>
                  {playing ? (
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 bg-cream" />
                      Playing
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-col gap-2.5">
                  {layer !== "en" ? (
                    hindi === undefined ? (
                      <p className="text-[14px] text-stone">
                        The Hindi is still being written.
                      </p>
                    ) : (
                      <p lang="hi" className="text-[21px] leading-[1.6] text-pretty">
                        {glossaryRuns(hindi, glossary).map((run, i) =>
                          run.index < 0 ? (
                            <span key={i}>{run.text}</span>
                          ) : (
                            <button
                              key={i}
                              type="button"
                              onClick={() => setOpen(run.index)}
                              className="text-gloss hover:underline nua-focus"
                            >
                              {run.text}
                            </button>
                          )
                        )}
                      </p>
                    )
                  ) : null}
                  {layer !== "hi" ? (
                    <p
                      className={cn(
                        "leading-[1.5] text-pretty",
                        layer === "en" ? "text-[19px]" : "text-[15px] text-cream/60"
                      )}
                    >
                      {entry.source.text}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>

        <aside
          className="flex flex-col bg-panel lg:sticky lg:top-5"
          aria-labelledby="terms-heading"
        >
          <div className="border-b border-cream/10 px-[22px] pt-[22px] pb-4">
            <h3 id="terms-heading" className="text-[24px] font-medium tracking-[-0.02em]">
              Key terms
            </h3>
            <p className="mt-2 text-[14px] leading-[1.45] text-stone">
              {glossary.length === 0
                ? "The glossary is written with the brief, before any segment is adapted."
                : "Fixed for the whole clip. Select a term's time to play from where it is first said."}
            </p>
          </div>
          <ul className="flex flex-col px-3 pt-2 pb-3">
            {glossary.map((entry, index) => {
              const at = firstSaid(entry, segments);
              const isOpen = open === index;
              return (
                <li
                  key={`${index}-${entry.english}`}
                  className={cn(
                    "flex flex-col gap-2 border-t border-cream/8 px-3 py-3.5 transition-colors",
                    isOpen && "bg-panel-2"
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-[16px] font-medium">{entry.english}</span>
                    {at === null ? null : (
                      <button
                        type="button"
                        onClick={() => onSeek(Math.max(0, at - 0.3))}
                        className="text-[13px] text-cream/50 tabular-nums hover:text-cream nua-focus"
                        aria-label={`Play ${entry.english} from ${formatTime(at)}`}
                      >
                        {formatTime(at)}
                      </button>
                    )}
                    <span className="flex-1" />
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? -1 : index)}
                      aria-expanded={isOpen}
                      aria-label={`Why ${entry.english} reads this way`}
                      className="w-5 text-center text-[18px] leading-none text-cream/60 hover:text-cream nua-focus"
                    >
                      {isOpen ? "−" : "+"}
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span lang="hi" className="text-[20px]">
                      {entry.targetForm}
                    </span>
                    <span className="border border-cream/30 px-2 py-0.5 text-[12px] text-cream/75">
                      {DECISION_LABEL[entry.decision]}
                    </span>
                  </div>
                  {isOpen ? (
                    <p className="text-[14px] leading-[1.45] text-pretty text-stone">
                      {entry.why}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </aside>
      </div>
    </div>
  );
}
