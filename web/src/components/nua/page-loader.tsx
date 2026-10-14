"use client";

import { useEffect, useRef } from "react";
import { prefersReducedMotion, scramble } from "@/components/nua/scramble";

const WORDS = ["Listening", "Loading", "सुन रहे हैं"];

/**
 * The route-level loading screen: the brand's square with its dot, and a word
 * that keeps scrambling between "Listening" and "Loading" until the page is in.
 */
export function PageLoader() {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null || prefersReducedMotion()) return;
    const start = performance.now();
    let raf = requestAnimationFrame(function loop(t) {
      raf = requestAnimationFrame(loop);
      const age = t - start;
      const k = Math.floor(age / 1400);
      const word = WORDS[k % WORDS.length] ?? "Loading";
      const text = scramble(word, age - k * 1400, 650, k * 7);
      if (el.textContent !== text) el.textContent = text;
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      role="status"
      className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 pt-(--nav-space)"
    >
      <span aria-hidden className="relative flex size-14 items-center justify-center border-2 border-cream">
        <span className="size-2.5 animate-ping bg-cream" />
        <span className="absolute size-2.5 bg-cream" />
      </span>
      <span className="nua-display text-[max(32px,3vw)]">
        <em>
          <span ref={ref} aria-hidden>
            Loading
          </span>
        </em>
      </span>
      <span className="sr-only">Loading the page</span>
    </div>
  );
}
