import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface Mark {
  term: string;
  /** Hover text: the model's evidence, or what the audio did with the term. */
  title: string;
  className?: string;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Renders `text` with every occurrence of each mark's term wrapped in a <mark>.
 *
 * Longest terms first, so "idempotent operation" wins over "idempotent" where
 * both are marked. Case-insensitive, which matters for the English side (the
 * model quotes "Brachistochrone" from a sentence that says "brachistochrone")
 * and is a no-op for Devanagari.
 */
export function Highlight({ text, marks }: { text: string; marks: Mark[] }) {
  const usable = marks
    .filter((mark) => mark.term.trim() !== "")
    .sort((a, b) => b.term.length - a.term.length);

  if (usable.length === 0) return <>{text}</>;

  const pattern = new RegExp(
    `(${usable.map((mark) => escapeRegExp(mark.term)).join("|")})`,
    "gi"
  );
  const byTerm = new Map(usable.map((mark) => [mark.term.toLowerCase(), mark]));

  const parts: ReactNode[] = text.split(pattern).map((part, index) => {
    const mark = byTerm.get(part.toLowerCase());
    if (mark === undefined) return part;

    return (
      <mark
        key={index}
        title={mark.title}
        className={cn(
          "rounded bg-amber-200/70 px-0.5 text-inherit underline decoration-dotted underline-offset-4 dark:bg-amber-500/30",
          mark.className
        )}
      >
        {part}
      </mark>
    );
  });

  return <>{parts}</>;
}
