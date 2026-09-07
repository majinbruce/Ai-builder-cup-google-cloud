import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { successEnvelope, ApiError } from "@/lib/api/envelope";
import { apiFetchServer } from "@/lib/api/server";
import { meSchema, type Me, type UserRole } from "@/lib/api/schemas";

/**
 * ============================================================================
 * The Data Access Layer for "who is asking".
 * ============================================================================
 *
 * Every server-side authorisation decision in this app starts here, and every
 * one of them is a fresh answer from the API — which re-resolves the session
 * against Postgres on every request (the API deliberately does not use Better
 * Auth's cookie cache, so a revoked session stops working immediately).
 *
 * Nothing in this app trusts the cookie's contents. `proxy.ts` looks at whether
 * a session cookie EXISTS, which is an optimistic redirect and nothing more;
 * the real check is this call, made as close to the data as possible.
 *
 * `cache()` memoises for the duration of ONE server render pass, so a layout,
 * a page and three components can each call `getSession()` and the API sees one
 * request. It is a per-render memo, not a cross-request cache — there is no
 * window in which one user's session could be handed to another.
 */
export const getSession = cache(async (): Promise<Me | null> => {
  try {
    const body = await apiFetchServer("/api/auth/me", successEnvelope(meSchema));
    return body.data;
  } catch (error) {
    // 401 is the ordinary "signed out" answer, not a failure. Anything else —
    // the API being down, a 500 — must not be silently rendered as signed out,
    // because that turns an outage into a redirect loop through the sign-in
    // page. Let it hit the error boundary instead.
    if (error instanceof ApiError && error.isUnauthorized) return null;
    throw error;
  }
});

/**
 * The guard for a protected server component. Redirects instead of returning
 * null, so the caller gets a non-nullable session and no `if (!session)` branch
 * that a future edit could drop.
 *
 * `redirect()` throws, so nothing after this line runs when there is no
 * session — TypeScript understands that through the `never` return.
 */
export async function requireSession(redirectTo = "/sign-in"): Promise<Me> {
  const session = await getSession();

  if (!session) {
    redirect(redirectTo);
  }

  return session;
}

/**
 * Role check, server side. The API enforces the same rule on the route itself
 * (`app.requireRole("admin")`) — this exists so an admin page renders a 404 or
 * a redirect instead of a screen full of failed requests.
 *
 * Never the ONLY check on anything that matters: this decides what to render,
 * the API decides what is allowed.
 *
 * One thing to expect when you test it by hand: the response is a 200 whose
 * streamed payload carries the redirect, not a 3xx. Next has usually flushed
 * the shell by the time this runs, so the navigation happens on the client. No
 * data is fetched either way — `redirect()` throws before the page's own
 * queries run.
 */
export async function requireRole(...roles: UserRole[]): Promise<Me> {
  const session = await requireSession();

  if (!roles.includes(session.user.role)) {
    redirect("/");
  }

  return session;
}
