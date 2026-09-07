# Fastify + TypeScript + PostgreSQL boilerplate

Production-shaped API skeleton: Fastify 5, TypeScript on Node's native type
stripping, Zod for validation _and_ serialization _and_ docs, Drizzle over `pg`.
No build step in development, no `tsx`.

Authentication is [Better Auth](https://better-auth.com) 1.7 — email/password
with verification and reset, "Continue with Google", and one session model
served over both httpOnly cookies (browser) and bearer tokens (everything else).
See [How auth works here](#how-auth-works-here).

A Next.js 16 frontend lives in [`web/`](web/README.md) — an empty landing page
you replace per project, plus the complete authentication UI wired to this API.
It is a separate npm project and a separate container. See
[The frontend](#the-frontend).

## Quick start

```bash
docker compose up
```

That is the whole setup. Compose starts Postgres (named volume, healthcheck),
runs the migrations as a one-shot service, and starts the API in watch mode with
your source bind-mounted — edits reload without a rebuild. It reads dev defaults
from the committed `.env.example`, so there is nothing to copy first.

- API: `http://localhost:3000`
- Docs: `http://localhost:3000/docs` (non-production only)
- Probes: `/health/live`, `/health/ready`

**Before you ship anything**, generate a real secret and put it in
`.env.development` (or your platform's env):

```bash
npm run auth:secret        # -> BETTER_AUTH_SECRET
```

Anything you set in `.env.development` overrides the defaults; the file is
gitignored. Google sign-in is optional and off until you add credentials — see
[Google OAuth setup](#google-oauth-setup).

Already using port 5432 or 3000? `PG_PUBLISHED_PORT=5433 PORT=3001 docker compose up`.

The frontend runs on the host, beside it:

```bash
cd web && npm install && npm run dev      # http://localhost:3001
```

There is no `web` service in `docker-compose.yml` on purpose — `next dev` watches
the filesystem far more happily outside a bind mount, and `next.config.ts`
rewrites `/api/*` to `http://127.0.0.1:3000` precisely so the two processes look
like one origin to the browser. Production is the opposite and does run it in a
container; see [Deploying](#deploying).

### Running without Docker

```bash
npm install
cp .env.example .env.development
docker compose up -d postgres    # or point PG_* at your own database
npm run migrate
npm run dev
```

## Scripts

| Script                     | What it does                                                        |
| -------------------------- | ------------------------------------------------------------------- |
| `npm run dev`              | `node --watch src/server.ts` — Node strips the types itself         |
| `npm run build`            | `tsc -p tsconfig.build.json` → `dist/`                              |
| `npm start`                | Runs the compiled output                                            |
| `npm run db:generate`      | Diffs `src/db/schema.ts` → a new migration in `db/migrations`       |
| `npm run migrate`          | Applies pending migrations (alias: `npm run db:migrate`)            |
| `npm run create-admin`     | Creates or promotes the first administrator — see below             |
| `npm run db:studio`        | Drizzle Studio, a browser UI over the live database                 |
| `npm run db:check`         | Warns about conflicting/duplicated migrations                       |
| `npm run auth:secret`      | Generates a `BETTER_AUTH_SECRET`                                    |
| `npm run auth:schema`      | Regenerates Better Auth's Drizzle schema after an upgrade — diff it |
| `npm run typecheck`        | `tsc --noEmit` over `src` and `test`                                |
| `npm test`                 | Both test projects — needs Postgres                                 |
| `npm run test:unit`        | `app.inject()` only; **no database required**                       |
| `npm run test:integration` | The ones that need a real Postgres                                  |
| `npm run lint`             | Type-aware ESLint                                                   |

## Layout

```
src/
  config/index.ts        env parsed by Zod at boot; nothing else reads process.env
  db/schema.ts           the tables, once — Drizzle queries, migrations and Better Auth
  lib/                   framework-free helpers (errors, envelope, redaction, mailer)
    auth.ts              CLI + type entrypoint; the running app never imports it
  plugins/               cross-cutting concerns, each wrapped in fp()
    config.ts            decorates app.config
    error-handler.ts     setErrorHandler + setNotFoundHandler
    db.ts                Drizzle instance (app.db) + the raw pg escape hatch (app.pg)
    security.ts          helmet, cors, compress, rate-limit, under-pressure
    auth.ts              Better Auth instance, app.requireAuth, app.requireRole
    swagger.ts           OpenAPI generated from the same Zod schemas
  modules/<feature>/     routes -> service -> repository, one folder per feature
    *.schemas.ts         Zod: validation + serialization + types + docs
    *.repository.ts      Drizzle queries; row types inferred from db/schema.ts
    *.service.ts         business rules, dependencies passed in
    *.routes.ts          schema declarations and thin handlers
    auth.emails.ts       the verification / reset templates (content, not wiring)
  app.ts                 builds the app (does NOT listen)
  server.ts              listens, waits for the DB, handles signals
db/migrations/           SQL generated by drizzle-kit, plus its journal
db/init/                 runs once on first Postgres boot (creates app_test)
test/                    app.inject() tests — the `unit` project, no database
  integration/           the `integration` project, needs a real Postgres
.github/workflows/ci.yml typecheck, lint, both test projects
web/                     the Next.js frontend — its own project, see web/README.md
```

## How auth works here

Authentication is [Better Auth](https://better-auth.com) (v1.7), mounted inside
Fastify. If you have not used it before, the one thing to understand is that it
is **not** a middleware you call helpers on — `betterAuth(options)` builds a
self-contained HTTP router with its own endpoints, validation, database access
and cookie handling. `src/modules/auth/auth.factory.ts` is therefore not
configuration _around_ the auth implementation; it **is** the implementation.

### The pieces

**The adapter.** `drizzleAdapter(db, { provider: "pg", schema })` hands Better
Auth the application's own Drizzle instance and the tables from
`src/db/schema.ts`. It does not own a connection — it builds queries on the
instance `plugins/db.ts` already pools, instruments and shuts down, so Better
Auth's queries appear in the same slow-query log as everything else.

More importantly, it removes a mapping. Under the previous Kysely adapter every
Better Auth field had to be told its column name (`emailVerified` →
`email_verified`) in `auth.factory.ts`, with a hand-written migration as the
other, unchecked half; the two could drift silently. Now the column name is read
off the table definition, so there is one definition and the compiler sees it.

**Plugins.** A Better Auth plugin can add endpoints, tables, request middleware
and client methods. Only one is enabled here: `bearer()`, and it is what makes
the mobile story work (below).

**Sessions.** A session is a **row in `sessions`** holding an opaque token. The
cookie carries that token and nothing else, so every authenticated request is an
indexed lookup. This is the opposite of a self-contained JWT, and it is the
whole reason a session is revocable: delete the row and the next request is a 401. Defaults are 7 days, refreshed at most once a day of use.

`session.cookieCache` is deliberately **off**. It would skip the per-request
lookup by trusting a short-lived signed cookie — a real performance win that
also means a revoked session keeps working until that cookie expires. There is a
test asserting revocation is immediate; turn the cache on when you have measured
that you need it, and expect that test to change.

**Accounts.** `users` is the person; `accounts` is one row per _way of signing
in_. The password hash lives on the `accounts` row with `provider_id =
'credential'`, not on the user — which is exactly why the same person can also
have a Google account attached. Passwords are hashed with **scrypt** by default.

### The four tables

| Table           | Holds                                                           |
| --------------- | --------------------------------------------------------------- |
| `users`         | the person: name, email, `email_verified`, `role`               |
| `sessions`      | one row per active login; the token the cookie/bearer carries   |
| `accounts`      | one row per sign-in method; the scrypt hash lives here          |
| `verifications` | short-lived tokens: verification, reset, and OAuth state + PKCE |

### Protecting a route

Unchanged in shape from what this boilerplate did before, so the scope rule
still holds — declare it once and every route in the scope inherits it:

```ts
const secured: FastifyPluginAsyncZod = async (app) => {
  app.addHook("onRequest", app.requireAuth); // authentication
  app.delete("/:id", { preHandler: app.requireRole("admin") }, handler); // authorisation
};
```

Inside a guarded handler, narrow with `requireUser(request)` rather than a
non-null assertion — `request.user` is genuinely `null` on unauthenticated
routes, and two places rely on that.

Some rules cannot be a `preHandler`, because they depend on a path parameter
the hook has not seen validated yet. "Self or admin" is the common one, so it
has a helper that throws the same 403 through the same envelope:

```ts
app.get("/:id", { schema }, async (request) => {
  requireSelfOrAdmin(request, request.params.id);
  // ...
});
```

**Authenticating a caller is not authorising them.** The user module ships with
an explicit model, stated in one block at the top of `user.routes.ts`:

| Route         | Who         | Notes                                 |
| ------------- | ----------- | ------------------------------------- |
| `GET /`       | admin       | the list carries every user's email   |
| `GET /:id`    | self, admin |                                       |
| `PATCH /me`   | self        | name only — **never** `role`          |
| `PATCH /:id`  | admin       | name and `role`                       |
| `DELETE /:id` | admin       | cascades sessions and linked accounts |

`role` is writable only through the admin route, and that is a security control
rather than a product decision: `auth.factory.ts` marks the field `input: false`
so a sign-up body cannot grant admin, and a self-service `PATCH` that accepted
`role` would hand that escalation straight back. It is why `PATCH /me` is a
separate route with a separate body schema instead of one route checking who is
calling. Both update schemas are `strictObject`, so an unexpected field is a 400
rather than a silent strip — a caller who just tried to set `role` should be
told, not thanked.

Loosen any of this per project, but loosen it in that block, where the whole
model is visible at once.

### The first administrator

`role` is `input: false` and the only route that writes it is itself
admin-guarded, which is the point — but it also means a freshly migrated
database has no admin and no way through HTTP to get one. The bootstrap comes
from outside the request surface, on purpose:

```bash
# You already signed up through the app — promote that account:
npm run create-admin -- you@example.com

# Nothing exists yet (fresh deploy, mailer not wired up):
ADMIN_PASSWORD='...' npm run create-admin -- you@example.com --create
```

`--create` goes through Better Auth's own sign-up, so the password is hashed
with the same scrypt parameters a real registration uses and is held to the same
strength policy. It marks the account email-verified, because on a fresh deploy
the mailer may not be configured yet and an admin who cannot sign in is not an
admin.

The password arrives in an environment variable rather than in `argv` because
`argv` is visible in `ps` output and lands in shell history. Re-running is safe:
promoting an existing admin is a no-op.

### Password and profile-image policy

Better Auth validates _shape_ — that a password is a string of a given length,
that `image` is a string — and stops there. Both values then go somewhere that
cares about more than shape, so `src/modules/auth/auth.policies.ts` owns the
rules and `auth.factory.ts` wires them in. They are pure functions with no
Fastify and no Better Auth in scope, because they are the part you will actually
want to edit per project.

**Passwords** are refused when they are a denylisted common password, that same
password wearing trailing digits or punctuation (`Password123` collapses to
`password`), a single repeated character, a straight run off the keyboard, or a
string containing the user's own email local-part or the app name. The check
runs on `hooks.before`, which is the only place a password exists in plaintext.

It applies to the paths that **set** a password — sign-up, reset, change, set —
and deliberately not to sign-in: enforcing strength at the door would lock out
everyone who registered before you tightened the rule, instead of prompting
them. `isBreachedPassword` is a resolved `false` with the HaveIBeenPwned
k-anonymity call written out in a comment; that is the seam to fill in when the
app handles anything that matters.

**Profile images** must be absolute `https` URLs (also `http` outside
production), under 2KB, with no embedded credentials. Scheme is an allow-list,
so `javascript:`, `data:`, `file:` and whatever the next browser ships are all
refused by not being named. This is a `databaseHooks.user` check rather than a
route check because three separate paths write the field — sign-up,
`update-user`, and the OAuth callback copying the provider's picture — and only
the database hook sees all three. Without it, `POST /api/auth/update-user`
stores `javascript:alert(1)` and hands it to every client that renders a
profile.

`request.user` and `request.session` are fully typed, and the types are
**derived from the config** via `typeof auth.$Infer.Session`. Add a field to
`user.additionalFields` and the request types follow with no second edit.

### Cookie and bearer are one session, not two systems

`requireAuth` is a single call:

```ts
const resolved = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
```

That call checks the session cookie, and — because `bearer()` is registered —
also `Authorization: Bearer`. Both carry the same opaque token and resolve to the
**same row** in `sessions`. There is no branch on client type, no second token
format, no refresh-token dance. A test asserts both transports return an
identical session id.

**What a mobile client does differently:** exactly one thing. On sign-in it
reads the `set-auth-token` response header and stores that string itself
(Keychain / Keystore — not `localStorage`), then sends `Authorization: Bearer
<token>` on every request. Same endpoints, same session, same expiry, same
revocation. For native Google sign-in, `POST /api/auth/sign-in/social` also
accepts an `idToken` so the device can skip the browser redirect entirely.

The browser keeps cookies because they are `httpOnly`: an XSS bug cannot read
the session out of them. That protection is unavailable to a token you have to
hand to JavaScript, which is why bearer is the fallback and not the default.

### What the OAuth callback actually does

1. Frontend calls `signIn.social({ provider: "google", callbackURL })`.
2. Backend generates OAuth `state` + a PKCE verifier, **stores them in
   `verifications` along with `callbackURL`**, and 302s to Google.
3. User consents at Google.
4. Google redirects to `/api/auth/callback/google?code=…&state=…`.
5. Backend looks up `state` — this is what rejects a forged or replayed
   callback — and exchanges `code` for tokens **server-side**, so the client
   secret never reaches a browser.
6. Fetches the Google profile, finds-or-creates the `users` row, upserts the
   `accounts` row.
7. Creates a `sessions` row and sets the httpOnly cookie.
8. 302s the browser to the `callbackURL` recovered in step 5.

**Account linking.** Sign up with a password and later use "Continue with
Google" at the same address and you get **one** user with **two** `accounts`
rows. The safety condition is upstream's default and is kept: implicit linking
requires the existing local row to already be email-verified, so an attacker
cannot pre-register an unverified account at your address and have your Google
identity linked into their row.

### Two things that surprise people

**`/api/auth/*` does not use the standard envelope.** Better Auth returns its
own `{ code, message }` shape and the Better Auth client SDK parses exactly
that, so rewriting it would break every SDK method. This is the one documented
exception; everything else in the API, including `GET /api/auth/me`, uses the
envelope.

**Origin headers are required.** Better Auth refuses a state-changing request
that arrives with cookies but no (or an untrusted) `Origin` — that is its CSRF
defence. Browsers always send one; `curl` and test helpers must be told to.
Note that `advanced.disableOriginCheck` is pinned to `false` in the factory
**on purpose**: left unset, Better Auth turns origin validation off whenever
`NODE_ENV=test`, and a security control should not vary by environment.

## Transactional email

Better Auth never sends mail itself — it builds the URL and hands it to a
callback. Everything after that is ours, split in two:

| File                              | Owns                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/lib/mailer.ts`               | the `Mailer` interface, the console dev implementation and the Resend one — _how_ a message is delivered |
| `src/modules/auth/auth.emails.ts` | the verification and reset templates — _what_ the message says and looks like                            |

The split is the point: rewording an email should not be a diff against your
auth configuration, and swapping Resend for SES should not touch a template.

**The templates are production-shaped, not placeholders.** Table-based layout
with inline styles (Gmail strips `<style>`; Outlook's renderer predates
flexbox), every colour stated explicitly, a padded `<a>` as the button rather
than an image, a preheader line, and a plain-text alternative that carries the
same link. The raw URL is always printed under the button, because corporate
mail scanners rewrite and strip links and that is the user's only fallback.

No template engine. Two transactional emails do not justify MJML or Handlebars,
and a boilerplate should not pick yours.

Rebranding is `APP_NAME`, plus the `THEME` object at the top of
`auth.emails.ts`. Changing `APP_NAME` is safe at any time — cookie names come
from `cookiePrefix`, which does not derive from it, so a rename does not sign
everyone out.

### Going to production: Resend

Two environment variables, no code change:

```bash
MAIL_PROVIDER=resend
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxx
EMAIL_FROM=no-reply@yourdomain.com     # must be on a domain verified in Resend
EMAIL_REPLY_TO=support@yourdomain.com  # optional, but a no-reply that eats replies is rude
```

`createMailer()` in `plugins/auth.ts` reads `MAIL_PROVIDER` and builds the
matching implementation. `console` is the default so a fresh clone runs with no
account anywhere; it is **refused at boot in production**, because a mailer that
logs instead of sending does not fail — it succeeds while delivering every
verification link to nobody.

Before the first send: add your domain at
[resend.com/domains](https://resend.com/domains) and publish the DNS records it
gives you (SPF + DKIM, and DMARC if you want deliverability rather than
delivery). `EMAIL_FROM` on an unverified domain comes back as
`invalid_from_address`. `onboarding@resend.dev` needs no domain and is fine for
one smoke test, but only delivers to your own account's address.

Three things in `createResendMailer` are worth knowing about before you copy the
pattern to another provider:

- **The SDK does not throw on an API error.** It resolves with `{ data, error }`
  and hands you the failure as a value, so the obvious `try { await send() }`
  adapter reports every rejected message as sent, and the first symptom is a
  user saying the email never arrived. The `error` branch is checked explicitly.
- **Retries reuse one idempotency key per message.** Bounded — three attempts,
  exponential backoff with jitter — because this runs inside the HTTP request
  that triggered it. A request that reached Resend but failed on the way back is
  retried without producing a second copy of the same verification email.
- **Only errors a second identical request could fix are retried.** 429, 5xx,
  network throws, a per-attempt timeout and `concurrent_idempotent_requests`
  (409 — which the timeout itself provokes, since the abandoned attempt is
  still in flight when the retry lands) yes. `validation_error`,
  `invalid_from_address` and quota exhaustion, no: retrying those only delays
  the error the caller needs to see.
- **Each attempt is bounded at 5s.** The SDK takes no `AbortSignal`, so a hung
  request is abandoned rather than cancelled, and Node's `fetch` would otherwise
  wait minutes — inside the sign-up request. Three attempts plus backoff is a
  ~16s worst case.

Verified against the live API, not reasoned about: forcing all three attempts to
be abandoned mid-flight sent three requests carrying one idempotency key and
produced **exactly one delivered email**. The corollary is that failure
reporting is one-sided — a timeout can log "delivery failed" for a message that
was in fact delivered, because an abandoned request cannot be distinguished from
a slow one. At-most-once is the property being defended; the log line means "we
never saw it land".

**One thing to know before you ship it, because it is Better Auth's behaviour
and not something `mailer.ts` can change:** a failed verification email does
**not** fail sign-up. `POST /sign-up/email` answers `200` whether or not the
message went out, so a provider outage produces accounts that exist and can
never be activated, with a success response in front of them. Verified against
this codebase, not assumed:

| Endpoint                        | Mailer throws                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `POST /sign-up/email`           | still `200` — swallowed                                                                                               |
| `POST /send-verification-email` | `500` — surfaced                                                                                                      |
| `POST /request-password-reset`  | `200` neutral message, same as for an unknown address — so a send failure is not an account-enumeration oracle either |

So the failure is only visible in your logs. That is why giving up logs at
`ERROR` with `"email delivery failed — giving up"` before it throws: **alert on
that line.** The user's own recourse is `POST /send-verification-email`, which
does return the failure.

### What this deliberately does not do

Three gaps, listed so you find them here rather than in production. None blocks
a side project; all three matter once real volume does.

- **No bounce or complaint handling.** Resend can webhook `email.bounced` and
  `email.complained` at you; nothing here consumes them, so a hard-bouncing
  address is retried by users forever and your domain reputation pays for it.
  Add a route and a suppression check if you send to addresses you did not
  verify.
- **Sends are inline, not queued.** The send happens inside the HTTP request
  that triggered it, so a slow provider is a slow sign-up (bounded: three
  attempts, 10s each). No outbox table, no worker — correct at low volume, and
  the thing to replace first if email ever becomes a bulk concern.
- **No open/click tracking, no templates in Resend.** The markup is ours (see
  `auth.emails.ts`), which is the point.

Swapping in SES, Postmark or SMTP is one more `Mailer` in `mailer.ts` and one
more arm in `createMailer` — plus a value in the `MAIL_PROVIDER` enum in
`config/index.ts`. Nothing else in the app knows which one is running, which is
also why the test suite can inject a fake (`buildTestApp(fakeMailer)`) and read
verification tokens straight out of the message.

> **User input reaches the inbox.** `name` is whatever someone typed at sign-up,
> and with account linking it can arrive in an inbox that is not theirs. Every
> interpolated value is escaped, and there is a test asserting a hostile display
> name is escaped rather than injected. Keep that true if you edit the markup.

## The frontend

`web/` is a Next.js 16 app: App Router, Tailwind v4, shadcn/ui, and the complete
authentication UI for this API. The landing page is deliberately empty — that
one file is what each project replaces. [`web/README.md`](web/README.md) is the
long-form version; this is the part that concerns **this** side of the wire.

### One origin, two containers

The browser only ever talks to one origin. Client code calls relative paths —
`/api/auth/sign-in/email`, `/api/v1/users` — and never names this API's host.
What forwards those paths here differs by environment:

| | forwards `/api/*` | |
| --- | --- | --- |
| development | a rewrite in `web/next.config.ts` | `next dev` on `:3001`, this API on `:3000` |
| production | Caddy, by path | one hostname, two upstream containers |

That single decision removes three problems that a `app.` / `api.` split
creates: there are no cross-origin browser requests, so CORS never applies; the
session cookie is first-party, so `SameSite=None`, `COOKIE_DOMAIN` and Safari's
tracking prevention are all irrelevant; and there is one origin for Better Auth
to build absolute URLs from.

Which is the part that catches people:

```
BETTER_AUTH_URL=https://proj1.example.com     # the FRONTEND's origin
FRONTEND_URL=https://proj1.example.com        # the same
TRUSTED_ORIGINS=https://proj1.example.com     # defaults to FRONTEND_URL
```

Not `api.proj1.example.com`. Better Auth builds the Google `redirect_uri`, the
email verification link and the password reset link from `BETTER_AUTH_URL`, and
all three have to land where the session cookie exists. Locally that is
`http://localhost:3001` for the same reason.

If a mobile client or a third party needs the API on its own hostname, add one —
the Caddyfile has a commented block for it. It serves the same container, and
bearer tokens resolve to the same `sessions` row a cookie would, so nothing
about the browser flows changes.

### What the frontend depends on here

Four things, all of them already true — this is the list to check before
changing them:

1. **Better Auth's own response shape** on `/api/auth/*`. `auth.routes.ts`
   passes it through untouched because the frontend uses Better Auth's client
   SDK, which parses exactly that. Wrapping those routes in the house envelope
   breaks every SDK call.
2. **`GET /api/auth/me`**, in the house envelope. It is the frontend's
   server-side session read, and its DTO is mirrored and parsed at runtime in
   `web/src/lib/api/schemas.ts`.
3. **`details[]` on a 400.** Each `{ field, message }` is mapped onto the form
   input that produced it, so a `z.strictObject` rejection shows up under the
   field rather than as a toast.
4. **`x-request-id` on every response.** It is surfaced in the frontend's error
   objects, so a user-reported failure is one grep on the server.

### Session checks, and which one is enforcement

The frontend has three layers and only the third one decides anything:

1. `web/src/proxy.ts` checks whether a session **cookie exists** and redirects.
   It never validates one — it runs on every prefetch.
2. `requireSession()` / `requireRole()` call `GET /api/auth/me`, so the answer
   comes from this API resolving the session against Postgres.
3. `app.requireAuth` and `app.requireRole("admin")` on the route. **This** is
   the permission. A forged cookie gets past layer 1 and straight into a 401.

So nothing about the frontend relaxes anything here, and `role` on that side is
display-only.

## Deploying

Four settings are boot-enforced in production, because each fails silently and
expensively otherwise. The app refuses to start without them:

| Variable             | Why it is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CORS_ORIGINS`       | `*` is rejected. CORS runs with `credentials: true`, so the wildcard reflects the caller's Origin **and** tells the browser to send cookies — any site a signed-in user visits can read authenticated responses. `SameSite=lax` blunts it. With the bundled frontend there is no cross-origin browser traffic at all (see [The frontend](#the-frontend)), so this list only needs the origins of clients that genuinely call the API directly — set it to your public origin and nothing else.                                                                                            |
| `TRUST_PROXY`        | Must be set. It is how far `X-Forwarded-For` is trusted, and therefore what `request.ip` is — which is the rate-limit key in front of sign-in and password reset. `1` behind a single nginx/ALB/Cloudflare; a CIDR for specific peers; `false` only if the process is exposed directly. Blanket `true` is deliberately not the default: it trusts that header from anybody, so a client reaching the app directly can name its own IP and walk around the limiter. |
| `BETTER_AUTH_SECRET` | The values committed to this repository (`.env.example`, `.env.test`) are rejected by exact match. The secret signs session tokens, so a deploy still running the dev default lets anyone who has read this repository mint a valid session for any user — and nothing about it looks wrong at runtime. `npm run auth:secret` generates a real one.                                                                                                                |
| `MAIL_PROVIDER`      | `console` is rejected. It logs messages instead of sending them, so it does not error — it succeeds while every verification and password-reset link goes nowhere. Set `resend` and `RESEND_API_KEY`.                                                                                                                                                                                                                                                              |

The rest of the pre-flight list:

- `BETTER_AUTH_URL` — the origin **the browser** reaches Better Auth at. With the bundled frontend that is the frontend's public origin, not an `api.` hostname; see [The frontend](#the-frontend). Getting it wrong is `redirect_uri_mismatch`, and only in the environment whose value is wrong.
- `MAIL_PROVIDER=resend` and `RESEND_API_KEY`, with `EMAIL_FROM` on a domain verified in Resend. Boot-enforced: the console mailer logs the verification link instead of sending it, so nobody could activate an account.
- `npm run create-admin` — until you run it there is no admin, and every admin-only route is unreachable. See [The first administrator](#the-first-administrator).
- Build the Dockerfile's `runtime` stage. `docker-compose.yml` is development only; `compose.prod.yml` is below.

Two more that are optional but worth setting on a real deploy:

- `SHUTDOWN_DRAIN_MS` — defaults to `5000` in production, `0` locally. On
  `SIGTERM` the process makes `/health/ready` return `503` **before** it closes
  anything, waits this long, and only then shuts down. That gap is what a proxy
  or orchestrator needs: it finds out this instance is going away by polling
  readiness on an interval, so closing the socket immediately means every
  request sent between the signal and the next poll is a connection reset for
  the user and a 502 in the proxy log — on every deploy. Set it to a couple of
  your health-check intervals. In-flight requests are unaffected either way;
  `app.close()` already waits for them.
- `SENTRY_DSN` — unset means Sentry is never initialised, nothing is sent, and
  no socket is opened, which is the default. Set it and unexpected 500s and
  crashes are reported with the request id, matched route and user id attached.
  Operational errors (validation, 404, 409) are deliberately never sent: they
  are the API working correctly, and reporting them buys a quota bill and an
  alert channel nobody reads. `sendDefaultPii` is off, so headers and cookies —
  the cookie header being a live session token — never leave the process.
  `SENTRY_TRACES_SAMPLE_RATE` defaults to `0` (errors only) and
  `APP_VERSION=$(git rev-parse --short HEAD)` makes a stack trace point at a
  commit.

`src/instrument.ts` is the first import in `server.ts` and has to stay there:
Sentry instruments `http` and `pg` by patching them as they load, so an init
that happens after those imports still reports errors but loses the request
context on all of them. Nothing fails if it moves — that is why it is commented.

One thing this list does **not** cover, because it is a decision rather than a
setting: both rate limiters store their counters in memory. That is correct for
a single instance and wrong the moment you run two — each replica then enforces
its own separate share of the limit, and a deploy resets every counter. Before
you scale past one instance, move `@fastify/rate-limit` onto a Redis store and
Better Auth's `rateLimit.storage` (in `auth.factory.ts`) to `"database"` or a
secondary store.

### On a single VPS

```sh
docker compose --env-file .env.production -f compose.prod.yml up -d --build
```

`--env-file` is required, and does two jobs: it fills the `${...}`
interpolations in the file (Compose reads those only from the shell or
`--env-file`, never from a service's own `env_file:`) and it is the same file
the containers load. One file, so the Postgres superuser Compose creates and the
credentials the app connects with cannot drift apart. Create
`.env.production` on the server from `.env.example` — it is gitignored — and
work through the pre-flight list above.

That command is the **first** deploy. Routine updates are `git push` from your
machine, then on the server:

```sh
./deploy/deploy.sh
```

— the same pull + rebuild, plus the verification steps nobody types by hand:
waits for the container to come up healthy, proves `/health/ready` through it,
stamps the commit into `APP_VERSION` for Sentry, and prunes dangling images.
See "Deploying an update" in [`deploy/README.md`](deploy/README.md).

It is a separate file rather than an override of `docker-compose.yml`, because
an override can add to the dev file but cannot remove from it, and the two
things that make the dev stack wrong in production are exactly removals: the
bind mount of your source over `/app`, and the published Postgres port.

Four details in that file are worth knowing before you edit it:

- **Nothing is published on the host at all**, not even on loopback. Caddy
  reaches the api over a shared `edge` Docker network by the alias
  `${PROJECT_SLUG}-api`, and terminates TLS in front. This is stricter than
  binding to `127.0.0.1` and removes a whole class of mistake: Docker writes
  its own iptables rules ahead of ufw's, so a port published on `0.0.0.0` by
  accident is reachable from the internet while `ufw status` still says it is
  not — and a port that was never published cannot be. It also means there is
  no port to allocate when a second project lands on the same box.
- **Postgres publishes nothing** and is on the project's private network only,
  so no other project can reach it. Its data lives in the `pgdata` volume,
  which `down -v` deletes. Backups are **not** optional and are no longer left
  to you: `deploy/host/backup/` has a nightly `pg_dump` that discovers every project
  on the box by Docker label, verifies each dump is a readable archive, syncs
  offsite, and reports to a dead-man's switch. Set it up before the project is
  worth backing up, not after.
- **`PROJECT_SLUG` must be distinct per clone.** It namespaces the Compose
  project, the image tag, the volumes and the network alias. Two clones sharing
  it are treated as the same stack — the second `up -d` adopts the first one's
  containers and its database volume.
- **The frontend is a second service in the same file**, built from
  `web/Dockerfile` and tagged `${PROJECT_SLUG}-web:prod`. Same rules: no
  published port, reached by Caddy over `edge` under the alias
  `${PROJECT_SLUG}-web`. Its env lives in `web/.env.production` (a separate file
  from this one), and `API_ORIGIN=http://api:3000` is set in the compose file
  rather than that file, because it is a fact about the network rather than a
  project setting. `deploy/deploy.sh` waits for its health probe too.
- **Several projects on one VPS** — the shared Caddy edge, per-project
  Postgres, backups, the expired-session prune and uptime monitoring — is
  documented end to end in [`deploy/README.md`](deploy/README.md).
- **`stop_grace_period: 30s`** has to stay above `SHUTDOWN_DRAIN_MS +
SHUTDOWN_TIMEOUT_MS`. Docker's default is 10s, which lands inside the
  readiness drain and `SIGKILL`s the process while it is still deliberately
  serving traffic — silently undoing the graceful shutdown on every deploy.
- **`PORT` is fixed at 3000 inside the container** and is not the way to change
  the port Caddy proxies to. Three things agree on 3000 in
  there — the `EXPOSE`, the Dockerfile's `HEALTHCHECK` (which curls a hardcoded
  `127.0.0.1:3000`) and the container side of the port mapping — and a `PORT`
  line in `.env.production` would move only the app.

## Google OAuth setup

Optional. With no credentials set, the provider simply is not registered and
everything else works.

1. [Google Cloud Console](https://console.cloud.google.com/) → create or pick a
   project.
2. **APIs & Services → OAuth consent screen** — configure it, and add yourself
   under _Test users_ while it is unpublished.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type **Web application**.
4. Under **Authorized redirect URIs**, add exactly:

   | Environment | URI                                                |
   | ----------- | -------------------------------------------------- |
   | Local       | `http://localhost:3001/api/auth/callback/google`   |
   | Production  | `https://your-domain.com/api/auth/callback/google` |

   The path is `{BETTER_AUTH_URL}{basePath}/callback/google`. It must match
   character for character — a trailing slash is a different URI.

   Note the **3001**: that is the frontend, not this API. With the frontend in
   place `BETTER_AUTH_URL` is the origin the browser uses, and the browser only
   ever sees the frontend's — see [The frontend](#the-frontend). Running this
   API on its own, with no `web/`, use `:3000` instead.

5. Put the credentials in `.env.development`:

   ```bash
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```

   Both or neither — the config schema rejects one without the other at boot.

6. Make sure `BETTER_AUTH_URL` is the origin you registered. Better Auth builds
   the `redirect_uri` from it, so a wrong value is the classic
   `redirect_uri_mismatch` — and it fails only in the environment that is wrong,
   which is usually production.

Set `FRONTEND_URL` (and `TRUSTED_ORIGINS` if they differ) to wherever the
browser should land afterwards. Every `callbackURL` is validated against
`TRUSTED_ORIGINS`; that check is what stops these endpoints being an open
redirect, so nothing is hardcoded and a split-origin deploy is a config change.

## Migrations

`src/db/schema.ts` is the source of truth. Edit it, generate the SQL, apply it:

```bash
npm run db:generate      # diffs the schema → db/migrations/NNNN_name.sql
npm run migrate          # applies everything pending
```

Generation and application are deliberately two different tools.
**drizzle-kit** generates, and is a devDependency. **drizzle-orm's own migrator**
applies, wrapped in `src/scripts/migrate.ts`, because the runtime image is built
with `npm ci --omit=dev` and would not have drizzle-kit — but does have
drizzle-orm. In Docker it runs as a one-shot `migrate` service before the API
starts. Bookkeeping lives in `drizzle.__drizzle_migrations`; each file runs once,
in journal order, in a transaction.

Generated migrations are **reviewed, not trusted**. Read the SQL before applying
it — drizzle-kit cannot tell a rename from a drop-plus-add, and will ask.
`npm run db:push` skips migrations entirely and pushes the schema straight at the
database; that is a scratch-database convenience, never a deploy step.

After a Better Auth upgrade:

```bash
npm run auth:schema      # writes the Drizzle schema Better Auth thinks it needs
```

Diff its output against `src/db/schema.ts`, fold in anything genuinely new, then
`npm run db:generate`. Deliberately **not** `auth migrate`: it diffs the live
database and records nothing in the journal, which would make it a second,
disagreeing source of truth for what has been applied.

Model names are remapped in `auth.factory.ts` (`user` → `users`, since `user` is
a reserved word in Postgres), and the `schema` passed to the adapter is keyed by
those names. Column names are no longer remapped anywhere — see the adapter note
above.

## Testing

```bash
npm run test:unit          # no database, ~1s
npm test                   # both projects; needs Postgres
```

Vitest runs **two projects**, and the split is not cosmetic. The pg pool
connects lazily, so everything that fails before touching the database —
validation, the auth guards, 404s, the error envelope — is genuinely testable on
a fresh clone with nothing running. Only the `integration` project carries a
`globalSetup`; a single shared one ran before every file and failed the whole
command, so `npm test` without Postgres produced zero passing tests and one
confusing error about a database the unit tests never wanted.

Integration tests (`test/integration/`) run against a real Postgres — the
`app_test` database that `db/init/` creates on first `docker compose up`. The
`globalSetup` migrates and truncates it once per run.

> `db/init/` runs **only** on first initialisation of the `pgdata` volume. If
> you had the volume before this file existed, `app_test` will not be there and
> the integration tests fail on connect. `docker compose down -v` and back up.

Real Postgres, because the interesting claims are ones a fake cannot settle
honestly: `ON DELETE CASCADE` revoking sessions, the unique index behind the
`23505` → 409 mapping, and Better Auth's own SQL against our column names. A
separate database rather than Testcontainers, because compose already gives you
a server and this needs no Docker socket in CI. Files still run in parallel —
isolation comes from every test minting a random email.

The mailer is injected (`buildTestApp(fakeMailer)`), so verification and reset
links are read out of the fake and followed exactly as a user would. That is
what the `Mailer` interface is for.

## The two rules the structure encodes

**1. `fp()` means shared, plain means private.**
`app.register(plugin)` runs the plugin inside a _child_ instance, so anything it
decorates or hooks dies with that child. `fastify-plugin` opts out of that, which
is right for a connection pool and wrong for a route group's auth hook. Every
file in `plugins/` is wrapped; nothing in `modules/` is.

**2. Scope is how you authorise, not repetition.**
`user.routes.ts` declares `addHook("onRequest", app.requireAuth)` exactly once,
inside a nested `register`. Every route added to that scope inherits it — including
routes added later by someone who never read the file. Forgetting to protect an
endpoint is not a mistake you can make from inside the scope.

## Why Zod instead of Joi

One schema produces four things: request validation, the response serializer,
the TypeScript type, and the OpenAPI page. The serializer only emits fields the
schema names, so a password hash that slips into a handler's return value is
dropped on the way out — a whole class of leak becomes structurally impossible.

## Drizzle, and the escape hatch

`app.db` is a Drizzle instance bound to `src/db/schema.ts`. One definition gives
the query builder its column types, drizzle-kit its migrations, and Better Auth
its adapter — a renamed column is a type error in all three rather than a
runtime 500 in one.

```ts
await db.select().from(users).where(eq(users.id, id));
await db.query.users.findFirst({ where: eq(users.id, id) });
await db.transaction(async (tx) => { ... });   // rolls back on throw
```

`app.pg` is the raw driver underneath, still there on purpose: `pg.query(sql,
params)`, `pg.withTransaction()`, `pg.pool`. Window functions, recursive CTEs,
`EXPLAIN ANALYZE` and one-off maintenance statements are all clearer as SQL text
than as builder expressions, and pretending otherwise is how an ORM starts
costing more than it saves — `list()` in `user.repository.ts` uses a raw
`COUNT(*) OVER()` fragment for exactly that reason. Both paths parameterise
everything; string interpolation of user input into SQL is the one rule with no
exceptions.

Queries made through `app.db` go through the same slow-query logging as
`app.pg`: Drizzle is handed a proxied pool rather than the pool itself, so
instrumentation sits at the driver and catches everything above it, Better
Auth's own queries included.

## Response envelope

```jsonc
{ "statusCode": 0,  "message": "...", "data": {} }             // success
{ "statusCode": 0,  "message": "...", "data": [], "meta": {} } // paginated
{ "statusCode": -1, "message": "...", "requestId": "...", "details": [] } // failure
```

`details` is always `[{ field, message }]`, and a validation failure reports every
bad field at once rather than one per round trip. Every response also carries an
`x-request-id` header matching the `reqId` in the logs.

The one exception is `/api/auth/*`, which returns Better Auth's own shape
because its client SDK depends on it — see
[How auth works here](#two-things-that-surprise-people).

## Error mapping

Handled centrally in `plugins/error-handler.ts`: Zod validation → 400, Postgres
`23505` → 409, `23503` → 400, `23502`/`22P02` → 400, `AppError` → its own status
(this is how `requireAuth`'s 401 and `requireRole`'s 403 are reported), oversized
body → 413, bad content type → 415. Anything unrecognised keeps its 500 and its
message is withheld in production.
