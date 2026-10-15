"use client";

import Script from "next/script";
import { prefersReducedMotion } from "@/components/nua/scramble";

/**
 * The designer's petal cursor (public/nua/cursor.js), drawn over every page.
 * It reads the background under the pointer and turns ink over cream, and steps
 * aside wherever a canvas draws its own pointer (an inline `cursor: none`).
 * The script skips touch screens itself; reduced motion keeps the system cursor.
 */
export function NuaCursor() {
  return (
    <Script
      src="/nua/cursor.js"
      strategy="afterInteractive"
      onReady={() => {
        if (!prefersReducedMotion()) window.NuaCursor?.site("petal");
      }}
    />
  );
}
