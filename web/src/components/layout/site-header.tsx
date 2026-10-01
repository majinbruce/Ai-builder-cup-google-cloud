import Link from "next/link";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthButton } from "@/components/auth/auth-button";
import { ErrorBoundary } from "@/components/error-boundary";
import { LogoMark } from "@/components/brand/logo-mark";
import { NavLinks } from "@/components/layout/nav-links";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { env } from "@/lib/env";

/**
 * The mark, the product name and the two places worth going: the demo, which
 * needs no account, and the upload flow.
 *
 * The auth slot is wrapped in Suspense so a slow session lookup streams in
 * behind a skeleton rather than holding the whole document, and in an
 * ErrorBoundary so that an unreachable API costs the page its avatar menu
 * rather than turning the landing page into a 500.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
        <nav className="flex min-w-0 items-center gap-3 text-sm sm:gap-5">
          <Link
            href="/"
            className="flex min-w-0 items-center gap-2 font-semibold tracking-tight"
          >
            <LogoMark />
            <span className="hidden truncate sm:inline">{env.APP_NAME}</span>
            <span className="sr-only sm:hidden">{env.APP_NAME}</span>
          </Link>
          <div className="flex items-center gap-1">
            <NavLinks />
          </div>
        </nav>

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
