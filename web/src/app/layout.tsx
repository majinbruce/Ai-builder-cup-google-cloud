import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/layout/site-header";
import { env } from "@/lib/env";
import { getSiteConfig } from "@/lib/site-config.server";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

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
      default: env.APP_NAME,
      template: `%s · ${env.APP_NAME}`,
    },
    description: "",
  };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const siteConfig = await getSiteConfig();

  return (
    // `suppressHydrationWarning` is required by next-themes and only by it: the
    // inline script it injects sets `class="dark"` on <html> before React
    // hydrates, so the server's markup and the client's genuinely differ by one
    // attribute. Without this, that legitimate difference is logged as an error
    // on every page load. It suppresses the warning for THIS element only.
    <html lang="en" suppressHydrationWarning className={cn("font-sans", geist.variable)}>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <Providers siteConfig={siteConfig}>
          <div className="flex min-h-dvh flex-col">
            <SiteHeader />
            <main className="flex-1">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
