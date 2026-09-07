import { requireSession } from "@/lib/auth-server";

/**
 * ============================================================================
 * The authenticated area. One check, inherited by every page inside it.
 * ============================================================================
 *
 * This mirrors the API's rule 2 — "authorize by scope, not by repetition".
 * There, `app.addHook("onRequest", app.requireAuth)` inside a nested register
 * covers every route in the scope; here, one `requireSession()` in a route
 * group's layout covers every page in the group.
 *
 * One caveat that is specific to Next.js and worth knowing before you rely on
 * it: a layout does NOT re-render on every client-side navigation between its
 * own pages. So this is the right place for the boundary of the SECTION, and
 * the wrong place for a check that has to be true of one particular page. Any
 * page with its own requirement (an admin list, a paid feature) calls
 * `requireRole()` / `requireSession()` itself as well — see admin/users.
 *
 * And as always, none of this is the real enforcement: every request this area
 * makes is authenticated again by the API against the database.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  await requireSession();

  return <div className="mx-auto w-full max-w-5xl px-4 py-10">{children}</div>;
}
