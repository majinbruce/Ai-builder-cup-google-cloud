---
paths:
  - "web/**"
---

# The Next.js app in `web/`

A SEPARATE npm project from the API at the repository root. Its own
package.json, lockfile, tsconfig, eslint config and Dockerfile. Never install a
frontend dependency into the root project or vice versa, and never import across
the boundary — the two are deployed as two containers.

Run its checks from `web/`:

    cd web && npm run typecheck && npm run lint && npm run build

`npm run typecheck` runs `next typegen` first. That is not optional: `PageProps`
and `LayoutProps` are generated from the route files, so a typecheck without it
checks against a stale route map.

## The three rules that are easy to get wrong

**1. The browser only ever calls relative paths.**
`/api/auth/...`, `/api/v1/...`. Never an absolute origin from client code.
`next.config.ts` rewrites them to the API in development and Caddy does it in
production, which is what makes the session cookie first-party and CORS
irrelevant. Server components are the exception and use `apiFetchServer`, which
builds an absolute URL from `API_ORIGIN` and forwards the incoming Cookie
header by hand.

**2. Only `src/lib/env.ts` reads `process.env`, there are no `NEXT_PUBLIC_*`
variables, and it never mirrors an API setting.**
`NEXT_PUBLIC_*` is inlined at build time, which would mean rebuilding the image
to change a value. Everything is read at runtime on the server; the few values
the browser needs go through `SiteConfig` and the root layout.

Anything the API already knows — which social providers are registered, whether
email verification is required — comes from `GET /api/auth/providers`, never
from a flag here. Two settings that must agree eventually do not, and the
failure is a sign-in button that 400s.

**3. `getSession()` decides what to RENDER. The API decides what is ALLOWED.**
`src/proxy.ts` only checks whether a session cookie exists — it never validates
one. `requireSession()` / `requireRole()` ask the API, which re-resolves the
session against Postgres. Neither is a substitute for the guard on the route
itself; every `/api/v1` route is authorised server-side regardless of what the
UI rendered.

## Conventions

- **shadcn/ui lives in `src/components/ui/` and is generated output.** Add with
  `npm run ui:add <name>`. Do not hand-edit those files expecting the edit to
  survive; wrap or compose instead.
- **One resource module per API surface**, in `src/lib/api/`. Components import
  named functions from it and never call `apiFetch` with a raw path.
- **Response schemas in `src/lib/api/schemas.ts` mirror the API's DTOs.** They
  are duplicated on purpose; keep them in sync in the same commit.
- **Better Auth's client resolves `{ data, error }` — it does not throw.**
  Everything else throws `ApiError`. Both go through `src/lib/auth-errors.ts` so
  a failure lands on the field that caused it.
- **`error.tsx` / `not-found.tsx` / `loading.tsx`** already exist at the root.
  Add segment-level ones only where the behaviour should genuinely differ.
- Forms: Zod schema in `src/lib/validation.ts`, `useForm(zodResolver(...))`, and
  shadcn's **`field`** primitives (`FieldGroup`/`Field`/`FieldLabel`/
  `FieldDescription`/`FieldError`) — what its official `login-*` blocks use.
  There is no `form.tsx`; `field` replaced it in this style and
  `npx shadcn add form` is a no-op. Never a bare `<input>` with hand-rolled
  error state.
