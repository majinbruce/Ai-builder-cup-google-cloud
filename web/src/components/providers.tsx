"use client";

import { createContext, useContext, type ReactNode } from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import type { SiteConfig } from "@/lib/site-config";

/**
 * ============================================================================
 * The single client-side provider tree.
 * ============================================================================
 *
 * One `"use client"` boundary, mounted once in the root layout. Everything
 * inside it is still a server component unless it says otherwise — passing a
 * server-rendered `children` through a client component does NOT make it a
 * client component, which is what keeps the page payload small.
 *
 * Add new app-wide providers HERE rather than wrapping the root layout again;
 * that keeps the boundary at one place in the tree and the reason for it
 * visible in one file.
 */

const SiteConfigContext = createContext<SiteConfig | null>(null);

/**
 * Client-visible configuration, handed down from the server rather than read
 * from `NEXT_PUBLIC_*`. See lib/env.ts for why: this is what makes one built
 * image configurable by the environment it starts in.
 */
export function useSiteConfig(): SiteConfig {
  const value = useContext(SiteConfigContext);

  if (value === null) {
    throw new Error("useSiteConfig must be used inside <Providers>");
  }

  return value;
}

export function Providers({
  siteConfig,
  children,
}: {
  siteConfig: SiteConfig;
  children: ReactNode;
}) {
  return (
    <SiteConfigContext.Provider value={siteConfig}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        // Without this every theme change animates every transition on the
        // page at once, which reads as a flash rather than a switch.
        disableTransitionOnChange
      >
        {children}
        <Toaster richColors position="top-center" />
      </ThemeProvider>
    </SiteConfigContext.Provider>
  );
}
