import Link from "next/link";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthButton } from "@/components/auth/auth-button";
import { ErrorBoundary } from "@/components/error-boundary";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { env } from "@/lib/env";

/**
 * The one piece of chrome the boilerplate ships. Everything project-specific —
 * navigation, a logo, a product name in the mark — replaces this file.
 *
 * The auth slot is wrapped in Suspense so a slow session lookup streams in
 * behind a skeleton rather than holding the whole document, and in an
 * ErrorBoundary so that an unreachable API costs the page its avatar menu
 * rather than turning the landing page into a 500.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4">
        <Link href="/" className="font-semibold tracking-tight">
          {env.APP_NAME}
        </Link>

        <div className="flex items-center gap-1.5">
          <ThemeToggle />
          <ErrorBoundary fallback={null}>
            <Suspense fallback={<Skeleton className="size-8 rounded-full" />}>
              <AuthButton />
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </header>
  );
}
