import { cn } from "@/lib/utils";

/**
 * Three lines of a transcript, the middle one highlighted: the product finds
 * the part of a lesson that matters and keeps it mattering. Same drawing as
 * app/icon.svg, in theme colours.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-6 shrink-0", className)}>
      <rect width="32" height="32" rx="7" className="fill-primary" />
      <rect
        x="7"
        y="9"
        width="18"
        height="3"
        rx="1.5"
        className="fill-primary-foreground"
      />
      <rect x="7" y="15" width="11" height="3" rx="1.5" fill="#F2B632" />
      <rect
        x="7"
        y="21"
        width="15"
        height="3"
        rx="1.5"
        className="fill-primary-foreground"
        opacity=".7"
      />
    </svg>
  );
}
