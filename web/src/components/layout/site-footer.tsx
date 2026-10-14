"use client";

import { usePathname } from "next/navigation";

/**
 * What the product runs on, for the reader who wants to know how much of it is
 * real. Every name here is load-bearing in the pipeline, not a logo wall. The
 * landing page closes with the full Nua footer instead.
 */
export function SiteFooter() {
  if (usePathname() === "/") return null;

  return (
    <footer className="relative mx-(--gutter) mt-24 flex flex-wrap justify-between gap-x-6 gap-y-2 border-t border-cream/14 pt-6 pb-10 text-[13px] text-cream/50">
      <p>
        Built for the AI Builder Cup by Google. Gemini listens, adapts, critiques and
        speaks; it all runs on Cloud Run.
      </p>
      <p>English to Hindi, with the reasoning shown.</p>
    </footer>
  );
}
