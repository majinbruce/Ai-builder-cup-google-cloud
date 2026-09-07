---
name: new-module
description: Scaffold a new feature module (routes, service, repository, schemas) following this repo's layered structure, and mount it in app.ts. Use when adding a new resource or feature area to the API.
---

# Add a feature module

A module is one folder under `src/modules/<feature>/` with four files, mounted
from `app.ts`. `src/modules/user/` is the reference implementation — read it
before writing, and follow its shape rather than inventing a new one.

Ask for the resource name and its permission model if the request did not state
them. Everything else follows from the steps below.

## 1. `<feature>.schemas.ts` — write this first

Every other file derives its types from here. One Zod object is simultaneously
the request validator, the response serializer, the TypeScript type, and the
OpenAPI documentation.

- Export a `<feature>DtoSchema` describing exactly what the API returns, and
  `export type <Feature>Dto = z.infer<typeof ...>`.
- **A field absent from the DTO schema is dropped from the response.** That is
  the mechanism that keeps internal columns from leaking; do not defeat it by
  adding fields you do not intend to expose.
- Bodies use `z.strictObject`, so an unknown key is a 400 rather than a silent
  strip, plus `.refine(body => Object.keys(body).length > 0, ...)` on partial
  updates.
- If some fields are writable only by an admin, write **two body schemas**, not
  one with conditional logic. Collapsing them is how a privileged field leaks
  into a self-service route.
- List queries: `z.coerce.number()` for `page`/`limit` (query strings are always
  strings), and cap `limit` with `.max(100)`.

## 2. `<feature>.repository.ts`

Drizzle queries only — no business rules, no HTTP concepts.

- Take `db: Database` (from `../../plugins/db.ts`) as the first argument.
- Import tables from `../../db/schema.ts` so row types are inferred, not
  declared. A renamed column must break the build, not return `undefined`.
- Export a `toDto(row)` mapper. Convert dates with `.toISOString()`.
- Paginate with `COUNT(*) OVER()` in the same query rather than a second
  `COUNT`, so the page and the total cannot disagree.
- For search, escape LIKE metacharacters before building the pattern — copy
  `escapeLikePattern` from `user.repository.ts`. Parameterisation stops
  injection but not `%` and `_`.
- Never interpolate user input into `sql` fragments. `sql` is for fixed
  fragments only.

## 3. `<feature>.service.ts`

Business rules live here; the route only declares schemas and formats output.

- Take a `Ctx` argument (`{ db, log }`) rather than importing a pool. That is
  what makes the service testable and what puts the request's `reqId` on every
  line it logs.
- Throw the helpers from `../../lib/errors.ts` (`notFound`, `conflict`, …) for
  expected outcomes instead of returning `null` and making callers check.
- Where a privileged field exists, give the unprivileged path its own function
  that destructures only the fields it may touch — so escalation is
  *unrepresentable*, not merely prevented by a schema in another file.

## 4. `<feature>.routes.ts`

- Type the plugin as `FastifyPluginAsyncZod`. **Do not wrap it in `fp()`** —
  route plugins get their own child scope, and that scope is what makes the auth
  hook non-leaky.
- Put authenticated routes in a nested plugin that calls
  `app.addHook("onRequest", app.requireAuth)` **once**. Every route in that
  scope inherits it, including ones added later by someone who never read the
  file.
- Authorization is per-route: `preHandler: app.requireRole("admin")` for a
  static rule, or a `requireSelfOrAdmin(request, id)` call inside the handler
  when the rule depends on a validated path param.
- Declare `response` for every status the route can produce, including errors
  (`errorEnvelope`), or the field is dropped from the payload.
- Return `ok(data, message)` or `paginated(data, meta, message)` from
  `../../lib/api-response.ts`.
- Open the file with a comment stating the full permission table for the module,
  the way `user.routes.ts` does. The whole model should be readable in one place.

## 5. Mount it in `src/app.ts`

Register after the plugins, with the prefix supplied at the registration site
rather than inside the route file:

```ts
await app.register(<feature>Routes, { prefix: "/api/v1/<features>" });
```

## 6. Tests

- `test/<feature>.test.ts` for anything reachable without a database —
  validation, auth guards, 404s, the error envelope. These run with
  `npm run test:unit` on a fresh clone with nothing running.
- `test/integration/<feature>.test.ts` for anything that touches Postgres. Mint
  a unique email per test; isolation comes from that, not from serialising.

## 7. Verify

```
npm run typecheck && npm run lint && npm run test:unit
```

Then `npm run test:integration` if the module has integration tests and Postgres
is up. Report the actual output.

## Only if the module needs new tables

Add them to `src/db/schema.ts`, then `npm run db:generate`. Never hand-write a
file in `db/migrations/`.
