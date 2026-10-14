import { cn } from "@/lib/utils";

/**
 * The two hairlines that run down every page, 3vw in from each edge. The root
 * layout draws them once; a section with its own background draws its own
 * pair on top (`tone="ink"` on cream).
 */
export function Rails({ tone = "cream", className }: { tone?: "cream" | "ink"; className?: string }) {
  const line = tone === "cream" ? "bg-cream/14" : "bg-ink/14";
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0", className)}>
      <div className={cn("absolute inset-y-0 left-(--rail) w-px", line)} />
      <div className={cn("absolute inset-y-0 right-(--rail) w-px", line)} />
    </div>
  );
}

/**
 * A full-width hairline with a small square where it crosses each rail: the
 * design's section break.
 */
export function Divider({ tone = "cream", className }: { tone?: "cream" | "ink"; className?: string }) {
  const square = tone === "cream" ? "bg-cream" : "bg-ink";
  return (
    <div
      aria-hidden
      className={cn(
        "relative z-4 h-px",
        tone === "cream" ? "bg-cream/14" : "bg-ink/14",
        className
      )}
    >
      <div className={cn("absolute -top-[3px] left-(--rail) -ml-[3px] size-[7px]", square)} />
      <div className={cn("absolute -top-[3px] right-(--rail) -mr-[3px] size-[7px]", square)} />
    </div>
  );
}

/** The four small squares on a framed panel's corners. */
export function Corners() {
  const at = ["-top-1 -left-1", "-top-1 -right-1", "-bottom-1 -left-1", "-bottom-1 -right-1"];
  return (
    <>
      {at.map((position) => (
        <div key={position} aria-hidden className={cn("absolute size-[7px] bg-cream", position)} />
      ))}
    </>
  );
}
