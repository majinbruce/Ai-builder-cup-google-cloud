"use client";

import { useEffect } from "react";

/**
 * Arriving at /#lesson from another page: Next scrolls to the top on a route
 * change and the section's anchor is not honoured, so once the page is in,
 * bring the section named in the hash into view.
 */
export function HashScroll() {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id === "") return;
    const timer = setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    }, 80);
    return () => clearTimeout(timer);
  }, []);
  return null;
}
