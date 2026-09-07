@AGENTS.md

# The Next.js frontend

A separate npm project from the Fastify API at `../`. Two package.json files,
two lockfiles, two Dockerfiles, two containers. Nothing imports across the
boundary; the only contract between them is HTTP.

`../CLAUDE.md` covers the API. `README.md` here has the long-form reasoning
behind everything below.

## Commands

- `npm run dev` — http://localhost:3001, with `/api/*` rewritten to the API
- `npm run typecheck` — `next typegen && tsc --noEmit`; the typegen is required
- `npm run lint` / `npm run lint:fix`
- `npm run build` — the real check; several errors exist only at build time
- `npm run ui:add <component>` — vendor a shadcn/ui primitive

Before calling a change done: `npm run typecheck && npm run lint && npm run build`.

## Conventions that differ from the obvious default

- **Next.js 16 renamed `middleware.ts` to `proxy.ts`.** One per app, at
  `src/proxy.ts`, exporting `proxy` and `config`.
- **`params` and `searchParams` are promises.** Await them.
- **Route props come from generated types** — `PageProps<"/dashboard">`,
  `LayoutProps<"/">`. They exist only after `next typegen`, which is why it is
  part of `typecheck`.
- **No `NEXT_PUBLIC_*` variables, anywhere.** They are inlined at build time,
  and this image must be configurable by the environment it starts in. Server
  code reads `@/lib/env`; the browser gets `SiteConfig` from the root layout.
- **`import "server-only"` on any module that touches env, cookies or the API
  directly.** It turns "leaked to the client" from a security incident into a
  build error.
- Prettier: 90 columns, double quotes, ES5 trailing commas — same as the API.
- `no-console` is an ESLint error outside `error.tsx`.

## Architectural rules

**1. The browser only ever calls relative paths.**
`/api/auth/...` and `/api/v1/...`, never an absolute origin. `next.config.ts`
rewrites them in development; Caddy routes them in production. That is what
makes the session cookie first-party and removes CORS from the picture
entirely. Server components are the exception: `apiFetchServer` builds an
absolute URL from `API_ORIGIN` and forwards the incoming Cookie header, which a
plain `fetch` on the server does not do.

**2. `getSession()` decides what to render. The API decides what is allowed.**
`src/proxy.ts` checks only that a session cookie EXISTS — it never validates
one, because it runs on every prefetch. `requireSession()` and `requireRole()`
in `src/lib/auth-server.ts` ask the API, which re-resolves the session against
Postgres on every request. Neither replaces the guard on the API route itself.

**3. Authenticate by route group, not per page.**
`(app)/layout.tsx` calls `requireSession()` once and every page under it
inherits it — the mirror of the API's scope-wide `requireAuth` hook. A page
still calls `requireSession()`/`requireRole()` itself when it needs the session
object or has a narrower rule, because a layout does not re-render on
client-side navigation between its own pages.

**4. Only `src/lib/env.ts` reads `process.env`, and it never mirrors an API
setting.**
Anything the API already knows — which social providers are registered, whether
email verification is required — is read from `GET /api/auth/providers` in
`site-config.server.ts`, not restated as a flag here. Two settings that must
agree eventually do not. Adding a genuine frontend variable means adding it to
the Zod schema in `env.ts` and to `.env.example`.

**5. One resource module per API surface, in `src/lib/api/`.**
It owns the path, the method and the response schema for each endpoint.
Components import named functions from it; nothing calls `apiFetch` with a raw
path. `users.ts` is the reference.

**6. `src/lib/api/schemas.ts` mirrors the API's DTOs and is checked at runtime.**
The duplication is the price of two independently deployed services. Change a
DTO in the API and change it here in the same commit — `typecheck` cannot see
the drift, the parse at runtime can.

**7. `src/components/ui/` is generated output.**
Add primitives with `npm run ui:add`. Compose and wrap them; do not hand-edit
them expecting the edit to survive. Everything else lives in
`src/components/<area>/`.

Forms use shadcn's **`field`** primitives — `FieldGroup`, `Field`, `FieldLabel`,
`FieldDescription`, `FieldError` — which is what its official `login-*` blocks
are built from. There is no `form.tsx`; `field` replaced it in this style, and
`npx shadcn add form` is a no-op here. Wire validation with react-hook-form:
`register()` on the input, `data-invalid`/`aria-invalid` from
`formState.errors`, and `<FieldError errors={[errors.x]} />`.

**8. Two error conventions, one destination.**
Better Auth's client RESOLVES with `{ data, error }` and never throws.
Everything else throws `ApiError`. `src/lib/auth-errors.ts` turns both into a
message on the field that caused it; only what cannot be attributed becomes a
toast.

## Security invariants — do not relax without being asked

- Never build a redirect from a user-supplied value without `safeRedirect()`.
  `?next=` on the sign-in page is attacker-controlled by definition.
- `callbackURL` / `redirectTo` passed to Better Auth stay RELATIVE. The API
  checks them against `trustedOrigins`; an absolute URL is what that check
  exists to reject.
- `role` is display-only on this side. It gates what is rendered, never what is
  permitted — the API's admin guard is the permission.
- Do not add a field to `SiteConfig` unless it is safe in the page source. It
  ships to every visitor. `GET /api/auth/providers` is public for the same
  reason: it lists which front doors exist, never a client id or secret.
