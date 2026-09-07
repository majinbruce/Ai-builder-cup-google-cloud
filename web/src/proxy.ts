import { NextResponse, type NextRequest } from "next/server";

/**
 * ============================================================================
 * `proxy.ts` — what every other Next.js codebase still calls `middleware.ts`.
 * ============================================================================
 *
 * Renamed in Next.js 16; same file, same API, same position in the request
 * lifecycle. There is exactly one per app.
 *
 * ---------------------------------------------------------------------------
 * This is an OPTIMISTIC redirect, not an authorisation check.
 * ---------------------------------------------------------------------------
 *
 * It looks at whether a session cookie is PRESENT. It does not validate it, it
 * does not call the API, and it cannot tell a live session from one revoked ten
 * seconds ago. That is on purpose: this runs on every request including every
 * prefetch, so a database round trip here would multiply the API's load by the
 * number of links on the page.
 *
 * The real check is `getSession()` in `lib/auth-server.ts`, which asks the API,
 * which re-resolves the session against Postgres. A forged cookie gets past
 * this file and straight into a 401 — the only thing lost is a redirect that
 * would have been slightly prettier.
 *
 * What this buys is the common case: a signed-out user clicking a protected
 * link lands on /sign-in immediately, without a render, a fetch and a flash of
 * an empty dashboard.
 */

/**
 * Better Auth's cookie name. `cookiePrefix` defaults to "better-auth" and the
 * API does not override it (see the APP_NAME note in the API's config — renaming
 * the app deliberately does NOT rename the cookie, so nobody is signed out by a
 * branding change). `__Secure-` is prepended when the cookie is set with
 * `secure: true`, which is production; both names are checked.
 */
const SESSION_COOKIE = "better-auth.session_token";
const SECURE_SESSION_COOKIE = `__Secure-${SESSION_COOKIE}`;

/**
 * Route prefixes that require a session. Add to this list AND put a
 * `requireSession()` call in the route's layout — this list alone protects
 * nothing (see above).
 */
const PROTECTED_PREFIXES = ["/dashboard", "/settings", "/admin"];

/**
 * Pages a signed-in user has no reason to see. Landing on /sign-in with a live
 * session is almost always a stale bookmark or a back button.
 */
const AUTH_PAGES = ["/sign-in", "/sign-up", "/forgot-password"];

const DEFAULT_SIGNED_IN_PATH = "/dashboard";

function hasSessionCookie(request: NextRequest): boolean {
  return (
    request.cookies.has(SESSION_COOKIE) || request.cookies.has(SECURE_SESSION_COOKIE)
  );
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const signedIn = hasSessionCookie(request);

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

  if (isProtected && !signedIn) {
    const url = new URL("/sign-in", request.url);
    // Where to send them back to once they are in. Relative and same-origin by
    // construction — never echo a caller-supplied absolute URL into a redirect.
    url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  const isAuthPage = AUTH_PAGES.some((page) => pathname === page);

  if (isAuthPage && signedIn) {
    return NextResponse.redirect(new URL(DEFAULT_SIGNED_IN_PATH, request.url));
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Everything except the paths where this would be pure overhead:
   *
   *   api        — proxied to Fastify (dev) or never reaching Next at all
   *                (production, where Caddy routes it). Redirecting an API call
   *                to an HTML sign-in page is how a fetch ends up parsing a
   *                login form as JSON.
   *   _next/*    — build output and the image optimiser
   *   favicon &c — static files served from /public
   */
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?)$).*)",
  ],
};
