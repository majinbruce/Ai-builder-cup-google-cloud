"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * A cream line across the top of the window from the moment an in-app link is
 * pressed until the next page is on screen. Every page here renders on the
 * server, so without it a click looks like nothing happened for a second.
 */
export function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");

  // The route changed: finish the bar (adjusting state during render, so the
  // finished bar is in the same commit as the new page), then fade it.
  const route = `${pathname}?${search.toString()}`;
  const [seenRoute, setSeenRoute] = useState(route);
  if (seenRoute !== route) {
    setSeenRoute(route);
    if (state === "loading") setState("done");
  }
  useEffect(() => {
    if (state !== "done") return;
    const timer = setTimeout(() => setState("idle"), 400);
    return () => clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same page (a #section on it, or itself): nothing to load.
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }
      setState("loading");
    };
    // Capture phase: next/link cancels the click before it bubbles up here.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-100 h-[3px]"
      style={{ opacity: state === "idle" ? 0 : 1, transition: "opacity .3s" }}
    >
      <div
        className="h-full bg-lime shadow-[0_0_8px_rgb(216_220_106/70%)]"
        style={{
          width: state === "idle" ? "0%" : state === "loading" ? "80%" : "100%",
          transition:
            state === "loading"
              ? "width 8s cubic-bezier(.1,.7,.2,1)"
              : state === "done"
                ? "width .25s ease-out"
                : "none",
        }}
      />
    </div>
  );
}
