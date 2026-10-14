import Link from "next/link";
import { Suspense } from "react";
import { AuthButton } from "@/components/auth/auth-button";
import { ErrorBoundary } from "@/components/error-boundary";
import { NavLinks } from "@/components/layout/nav-links";

/**
 * The cream bar inset between the rails, floating over the top of every page:
 * the logo, the landing page's sections and the demo, and the auth slot.
 *
 * Absolutely positioned so the landing hero can run its video up behind it;
 * every other page leaves `--nav-space` above its content.
 *
 * The auth slot is wrapped in Suspense so a slow session lookup streams in
 * rather than holding the whole document, and in an ErrorBoundary so that an
 * unreachable API costs the page its account menu rather than turning the
 * landing page into a 500.
 */
export function SiteHeader() {
  return (
    <header className="absolute inset-x-(--rail) top-[2.15vw] z-20">
      <nav
        aria-label="Main"
        className="flex h-(--nav-h) items-center justify-between gap-4 bg-cream pr-[max(5px,0.4vw)] pl-[max(14px,1.6vw)] text-ink"
      >
        <Link href="/" className="flex shrink-0 nua-focus" aria-label="Nua, home">
          {/* eslint-disable-next-line @next/next/no-img-element -- a 162x80 brand mark */}
          <img src="/nua/assets/nua-logo.png" alt="nua." className="block h-[max(26px,2.3vw)]" />
        </Link>
        <div className="flex min-w-0 items-center gap-[max(16px,2.6vw)]">
          <NavLinks />
          <ErrorBoundary fallback={null}>
            <Suspense fallback={<span className="h-[max(42px,3.3vw)] w-24 bg-ink/10" />}>
              <AuthButton />
            </Suspense>
          </ErrorBoundary>
        </div>
      </nav>
    </header>
  );
}
