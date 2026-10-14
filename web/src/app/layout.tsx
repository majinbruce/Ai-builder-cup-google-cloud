import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { Providers } from "@/components/providers";
import { ClickSound } from "@/components/nua/click-sound";
import { NavProgress } from "@/components/nua/nav-progress";
import { Rails } from "@/components/nua/rails";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { env } from "@/lib/env";
import { getSiteConfig } from "@/lib/site-config.server";

/**
 * The brand's four faces, by name. A stylesheet rather than next/font because
 * the designer's canvas animations (public/nua/*.js) draw text with
 * `ctx.font = '… "Newsreader"'`: a canvas resolves real family names only, and
 * next/font renames every family it hosts. Tiro Devanagari Hindi is the Hindi
 * side of every job; without a Devanagari face a stock Linux box renders the
 * product as tofu boxes.
 */
const FONTS =
  "https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;1,6..72,400;1,6..72,600&family=Inter+Tight:wght@400;500&family=IBM+Plex+Mono:wght@400;500&family=Tiro+Devanagari+Hindi&display=swap";

/**
 * `generateMetadata` rather than a static `metadata` export, because the title
 * comes from APP_NAME — a runtime environment variable, read on the server.
 * A static export would be evaluated once at build time and bake one project's
 * name into every clone's image.
 */
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(env.APP_URL),
    title: {
      default: `${env.APP_NAME}: where meaning finds a new voice`,
      template: `%s · ${env.APP_NAME}`,
    },
    description:
      "Localizes English lectures into Hindi while keeping what the teacher defined, stressed and warned about, with the reasoning for every choice.",
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const siteConfig = await getSiteConfig();

  return (
    // One theme, so `dark` is fixed rather than toggled: the shadcn primitives'
    // `dark:` variants are the ones written for an ink background.
    // `suppressHydrationWarning` is for next-themes' inline script, which sets
    // the same class before React hydrates.
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={FONTS} />
      </head>
      <body className="min-h-dvh bg-ink font-sans text-cream">
        <Providers siteConfig={siteConfig}>
          <div className="relative flex min-h-dvh flex-col overflow-x-clip">
            <Rails className="z-3" />
            <SiteHeader />
            <main className="flex-1">{children}</main>
            <SiteFooter />
          </div>
          <ClickSound />
          {/* useSearchParams suspends; the boundary keeps pages static-capable. */}
          <Suspense fallback={null}>
            <NavProgress />
          </Suspense>
        </Providers>
      </body>
    </html>
  );
}
