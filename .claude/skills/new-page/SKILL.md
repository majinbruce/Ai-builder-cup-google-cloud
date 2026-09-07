---
name: new-page
description: Scaffold a new page or feature area in the Next.js app in web/ — route, data access, components — following this repo's App Router structure and auth boundaries. Use when adding a screen, a section, or a new API-backed feature to the frontend.
---

# Add a page to the frontend

Everything here happens under `web/`. The API's `new-module` skill is the
counterpart on the other side of the wire; if the page needs an endpoint that
does not exist yet, run that one first.

Ask for the route path and who is allowed to see it if the request did not say.
Everything else follows.

## 1. Decide which route group it belongs to

    src/app/page.tsx        the landing page — public, project-specific
    src/app/(auth)/...      sign-in, sign-up, reset — public, no chrome
    src/app/(app)/...       everything behind a session

Parentheses mean the folder contributes a LAYOUT but not a URL segment.
`(app)/dashboard/page.tsx` is `/dashboard`.

Putting the page under `(app)/` is what authenticates it: `(app)/layout.tsx`
calls `requireSession()` once for the whole group. Do not add a second identical
check for the sake of it — but DO call `requireSession()` or `requireRole()` in
the page itself when it needs the session object, or when its rule is narrower
than the group's (an admin page inside a user area). A layout does not re-render
on client-side navigation between its own pages, so a page-specific rule belongs
on the page.

If the route needs an optimistic redirect before render, add its prefix to
`PROTECTED_PREFIXES` in `src/proxy.ts`. That is a UX nicety and protects nothing
on its own — it never validates the cookie.

## 2. Server component first

A page is a server component unless something forces otherwise. Reach for
`"use client"` only for interactivity: state, effects, event handlers, a hook.
When a page needs both, keep the page a server component and push the
interactive part into a child in `src/components/`.

- `params` and `searchParams` are PROMISES. Await them.
- Type the props with the generated `PageProps<"/your/route">`. Run
  `npm run typecheck` (which runs `next typegen`) after creating the file, or
  the route will not exist in the type map yet.
- Export `metadata` — or `generateMetadata()` if the title depends on data or on
  an env var.

## 3. Data

Read on the server with `apiFetchServer(path, schema, options)` from
`@/lib/api/server`. It forwards the incoming Cookie header, which a plain
`fetch` does not — that is the whole reason it exists.

Read from the browser with the named functions in `src/lib/api/<resource>.ts`.
Add a new file there for a new API surface; it owns the path, the method and the
response schema for each endpoint, and components import from it rather than
calling `apiFetch` directly. `src/lib/api/users.ts` is the reference.

Response schemas compose `successEnvelope(...)` / `paginatedEnvelope(...)` from
`@/lib/api/envelope` around a DTO from `@/lib/api/schemas.ts`. If the DTO is new,
add it to `schemas.ts` mirroring the API's own Zod schema — field for field.

## 4. Components

- Compose from `src/components/ui/` (shadcn). Missing a primitive?
  `npm run ui:add dialog`. Never hand-write one that shadcn ships.
- Shared, non-`ui` components go in `src/components/<area>/`. Keep a component
  in the route folder only if it will never be used elsewhere.
- Pass data down as props rather than re-fetching in a leaf. `UserMenu` taking
  `user` instead of calling `useSession()` is the pattern.

## 5. Forms

Schema in `src/lib/validation.ts`, then `useForm(zodResolver(schema))` and
shadcn's `field` primitives — `FieldGroup`, `Field`, `FieldLabel`,
`FieldDescription`, `FieldError`. That is what shadcn's own `login-*` blocks are
built from; there is no `form.tsx` in this style and `shadcn add form` is a
no-op. Wire them with `register()`, `data-invalid`/`aria-invalid` from
`formState.errors`, and `<FieldError errors={[errors.field]} />`. On failure:

    Better Auth call   ->  { error }, resolved not thrown  ->  applyAuthError
    /api/v1 call       ->  throws ApiError with details[]  ->  applyFieldErrors

Anything neither helper could attribute to a field becomes a `toast.error`.
After a mutation that server components display, call `router.refresh()`.

## 6. Check it

    cd web && npm run typecheck && npm run lint && npm run build

The build is the real test: a `server-only` module imported from a client
component, or `useSearchParams` without a Suspense boundary, fails there and
nowhere earlier.
