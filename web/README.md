# The frontend

Next.js 16 (App Router) + TypeScript + Tailwind v4 + shadcn/ui, wired to the
Fastify API in the parent directory. Ships a deliberately empty landing page and
a complete, working authentication flow.

    npm install
    npm run dev          # http://localhost:3001

The API must be running too — `docker compose up -d` in the parent directory.

---

## The one idea worth understanding first

**The browser only ever talks to one origin.** Every request the client makes is
to a relative path: `/api/auth/sign-in/email`, `/api/v1/users`. Nothing in
client code ever names the API's host.

Who forwards those paths to Fastify depends on where you are:

| | forwards `/api/*` | why |
|---|---|---|
| development | a rewrite in `next.config.ts` | `next dev` is on :3001, the API on :3000 |
| production | Caddy, by path | one hostname, two upstream containers |

Everything else follows from that one decision:

- **No CORS.** Not a permissive policy — no cross-origin requests at all.
- **A first-party session cookie.** No `SameSite=None`, no `COOKIE_DOMAIN`, and
  nothing for Safari's tracking prevention to object to. The cookie that breaks
  on `api.example.com` read from `example.com` is the single most common way a
  split-origin setup fails, and it fails intermittently, per browser.
- **`BETTER_AUTH_URL` is the frontend's origin.** Better Auth builds the Google
  `redirect_uri`, the email verification link and the password reset link from
  it, and all three have to land somewhere the session cookie exists.

The alternative — `app.example.com` and `api.example.com` — works, and the
Caddyfile has a commented block for adding a bare API hostname when a mobile
client or a third party needs one. It is not the default because it costs a CORS
config, a cookie domain, and a class of bug that only shows up in someone else's
browser.

Server components are the exception, and a deliberate one: they call
`apiFetchServer`, which uses the absolute `API_ORIGIN` (the Docker network name
in production) and forwards the incoming `Cookie` header by hand. That header is
not automatic on the server, and forgetting it is the classic "works in the
browser, 401 on the server" bug.

---

## Configuration

There are no `NEXT_PUBLIC_*` variables in this app, on purpose.

`NEXT_PUBLIC_*` is inlined into the JavaScript bundle at build time, which means
changing one requires rebuilding the image. For a boilerplate that is cloned per
project and deployed as one container per project, that is the wrong trade. So:

- Everything is read on the server, at runtime, in `src/lib/env.ts` — validated
  by Zod, which fails at boot with every problem listed rather than at the first
  request.
- The handful of values the browser genuinely needs are assembled into a
  `SiteConfig` object by the root layout and passed down through a provider.

`import "server-only"` at the top of `env.ts` makes the boundary a build error
rather than a convention: if a client component ever imports it, the build fails
instead of shipping the environment to the browser.

See `.env.example` for the full list.

### What this app deliberately does NOT configure

Which social providers exist, and whether email verification is required, are
facts about the **API** process — Better Auth registers Google if and only if
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are both set. Mirroring that as a
flag here would be two settings that must agree, and the failure when they do
not is a "Continue with Google" button that returns a 400 in production.

So the API declares its own capabilities on `GET /api/auth/providers` and the
sign-in screen is rendered from the answer — the same idea as NextAuth's
`/providers`, for the same reason. Add Google credentials to the API's
environment, restart it, and the button appears here with no frontend change and
no rebuild. If the API is unreachable the screen still renders, email-only:
a social button we cannot confirm is one we should not draw.

---

## Authentication

Better Auth's own client SDK (`src/lib/auth-client.ts`) drives everything. There
is no hand-rolled fetch to `/api/auth/*` anywhere, and there should not be — the
SDK owns that wire format, including the `{ code, message }` error shape the
API's catch-all route deliberately passes through untouched.

What ships:

    /sign-in                 email + password, plus whatever social providers
                             GET /api/auth/providers reports
    /sign-up                 with confirm-password and the API's password policy
    /forgot-password         request a reset link
    /reset-password          consume the link (?token= / ?error=INVALID_TOKEN)
    /verify-email            "check your inbox", with a resend button
    /verify-email/callback   where the verification link lands
    /dashboard               the reference protected page
    /settings                the reference PATCH /api/v1 form
    /admin/users             the reference role-gated, paginated, server read

### Three layers, and only one of them is enforcement

1. **`src/proxy.ts`** (Next 16's renamed `middleware.ts`) checks whether a
   session cookie *exists* and redirects. It never validates one — it runs on
   every request including every prefetch, so a database round trip here would
   multiply the API's load by the number of links on the page. It buys the
   common case: no flash of an empty dashboard before the redirect.

2. **`getSession()` / `requireSession()` / `requireRole()`** in
   `src/lib/auth-server.ts` ask the API, which re-resolves the session against
   Postgres on every request (the API deliberately does not use Better Auth's
   cookie cache, so a revoked session stops working immediately). `React.cache`
   memoises this for one render pass, so a layout and three components cost one
   API call.

3. **The API's own guards.** `app.requireAuth` on the scope,
   `app.requireRole("admin")` on the route. This is the layer that decides what
   is permitted. Everything above it decides what is *rendered*.

A forged cookie gets past layer 1 and straight into a 401 from layer 3. That is
the design, not a gap in it.

### Error handling

Two conventions meet here, because the SDK owns one of them:

    Better Auth  ->  resolves { data, error }, never throws  ->  applyAuthError
    /api/v1      ->  throws ApiError with details[]          ->  applyFieldErrors

Both put the message on the field that caused it. Only what cannot be attributed
to a field becomes a toast. `src/lib/auth-errors.ts` is where the mapping lives,
including the reword of `INVALID_EMAIL_OR_PASSWORD` and the special case for
429, which on this API means one of the tight per-endpoint rate limits in
`auth.factory.ts` rather than the global one.

---

## Layout

    src/
      app/
        page.tsx              the landing page — EMPTY, replace per project
        layout.tsx            fonts, providers, header
        error.tsx             root error boundary
        healthz/route.ts      the container's liveness probe
        (auth)/               sign-in, sign-up, reset, verify — public
        (app)/                everything behind requireSession()
      components/
        ui/                   shadcn/ui — generated, add with `npm run ui:add`
        auth/                 forms and the user menu
        layout/               header, theme toggle
        providers.tsx         the one client boundary
      lib/
        env.ts                the only reader of process.env (server-only)
        auth-client.ts        Better Auth, browser
        auth-server.ts        the session DAL, server-only
        api/
          envelope.ts         the API's response envelope + ApiError
          client.ts           browser fetch  (relative URL)
          server.ts           server fetch   (absolute URL + forwarded cookie)
          schemas.ts          the API's DTOs, mirrored and parsed
          users.ts            one resource module per API surface
        validation.ts         form schemas
      proxy.ts                optimistic route redirects

Parenthesised folders are route groups: they contribute a layout but not a URL
segment, so `(app)/dashboard/page.tsx` is `/dashboard`.

---

## Adding to it

**A page:** see `.claude/skills/new-page/` in the repository root, or copy
`(app)/dashboard/page.tsx`.

**A component:** `npm run ui:add dialog` for anything shadcn ships. Compose
those into `src/components/<area>/`; do not hand-edit `src/components/ui/`,
which is generated output.

**An API call:** add a function to the resource module in `src/lib/api/`, or a
new module for a new surface. Components import named functions from there and
never call `apiFetch` with a raw path — that keeps an endpoint's URL, method and
response shape in one place.

**A form:** schema in `src/lib/validation.ts`, `useForm(zodResolver(...))`, and
shadcn's `field` primitives — the same ones its official `login-*` blocks use,
so `npx shadcn add login-04` and this codebase agree on structure. There is no
`form.tsx`: `field` replaced it in this style. `sign-in-form.tsx` is the
reference.

---

## Deployment

Built as `output: "standalone"` — `.next/standalone/server.js` plus only the
`node_modules` the app actually imports, which is the difference between a
~200MB image and a ~1GB one. `.next/static` and `public` are copied in
explicitly because standalone does not include them (the docs assume a CDN;
there is no CDN here).

On the VPS it is one more service in `compose.prod.yml`, reached by Caddy on the
shared `edge` network under the alias `${PROJECT_SLUG}-web`. No published port.
`deploy/deploy.sh` waits for its health probe the same way it waits for the
API's. The full topology is in `deploy/README.md`.

One caveat worth knowing: the header resolves the session on the server, which
makes every route that renders it dynamic. That is the right default for an app
behind a login. If a project needs a genuinely static marketing page, put the
header's auth slot behind a Suspense boundary and turn on `cacheComponents` —
do not scatter `useSession()` through the header to avoid it.
