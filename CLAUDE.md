# Intent-Preserving Localization — AI Builder Cup by Google (JAPAC)

## What this is
A hackathon prototype. Educational English audio/video (MOOCs, tech explainers,
corporate training) is localized to Hindi while preserving BOTH the emotional
register AND the pedagogical signal — emphasis on key terms, the "this part
matters" tonal shift, comprehension-calibrated pacing, and intent-preserving (not
literal) adaptation of idioms and cultural references. Every adaptation must
surface its own reasoning so the AI's judgment is auditable.

Full spec: `docs/SPEC.md` — read it before any non-trivial task. Verified Google
doc facts, model names and quotas: `docs/research.md` — cite it, not memory.

Team: Omkar builds everything; a designer owns `web/` visual polish, the deck and
the video. Theme: **Media, Content & Digital Experiences** (there is no Education
theme). Deadline 4 Oct 2026.

## Hard constraints (hackathon rules — never violate)
- All generative work uses Google AI models (Gemini / Gemma). No OpenAI/Anthropic APIs
  in the shipped prototype.
- Deployed on Google Cloud: API and frontend both on Cloud Run; files on GCS.
- All code, comments, docs, UI copy in English.
- A WORKING prototype, not a mockup. Every feature we claim must run end-to-end.
- Team of 2–4 registered; every line of project code written after 7 Sept 2026.

## Judging weights — optimize in this order
1. 40% Technical merit & Gen AI implementation — Gen AI must be load-bearing, not decorative.
2. 25% Problem alignment & impact — tie every feature back to "does it teach as well as the original?"
3. 25% Innovation — the differentiator is PEDAGOGICAL signal detection + auditable reasoning. Protect it.
4. 10% UX — clean and accessible, but don't over-invest.

## Stack additions on top of the boilerplate (verified 2026-09-07, see docs/research.md)
- Gemini `gemini-3.8-flash` via `@google/genai` **Interactions API**
  (`client.interactions.create`), AI Studio key. `generateContent` is legacy; do not
  use it. Vertex AI only as a NICE.
- Structured output: one Zod schema per stage → `z.toJSONSchema()` →
  `response_format.schema`, and the same schema `.parse()`s the reply and serializes
  the API response. Never hand-write JSON Schema.
- Speech in: Gemini native audio understanding (inline base64 ≤ 20 MB, else Files
  API). Speech out: **Cloud Text-to-Speech Chirp 3 HD `hi-IN`** (GA). Gemini TTS
  models are all Preview → NICE only.
- Storage: GCS bucket for uploads and outputs. Job state in Postgres via the
  existing Drizzle setup — do not add Firestore. Prod Postgres: Cloud SQL on
  credits → else the team's US VPS with `compose.prod.yml` → else Supabase.
- No ADK: the pipeline is a fixed typed sequence; a linear service is simpler.
- Better Auth stays; prod runs one seeded demo user with
  `AUTH_REQUIRE_EMAIL_VERIFICATION=false`.
- Jobs run async after the POST returns (Cloud Run request timeout is 300 s by
  default); the UI polls `GET /api/v1/localize/jobs/:id`. `min-instances=1` on the API.

## Core pipeline (the product) — lives in `src/modules/localize/`
1. Ingest: audio/video upload (≤ 25 MB, ≤ 180 s) → ffmpeg → 16 kHz mono mp3 in GCS.
2. Analyze (Gemini, audio in, JSON out): pedagogically segmented transcript with
   signal label (the 7-label enum in SPEC §c), register, pace, emphasis markers,
   idioms, key terms.
3. Adapt (Gemini, JSON out): Hindi script preserving intent, `literalText` beside it,
   `rationale` + one `why` per non-literal choice, TTS hints per segment.
4. Critique (Gemini, separate call, blind to the rationale): back-translate, score
   fidelity 0–100; segments < 70 are re-adapted ONCE with the critique attached.
5. Synthesize: Cloud TTS per segment with `speaking_rate` + `[pause]` markup (+ SSML
   prosody if the Phase 3 spike confirms Chirp 3 HD honors it), ffmpeg concat.
6. Present (`web/`): side-by-side original vs adapted with the reasoning panel — the demo.

## Project engineering rules (in addition to the boilerplate rules below)
- Every Gemini call returns JSON validated by a Zod schema. No free-text parsing.
- Prompts live in `src/prompts/<stage>.v1.md`, versioned, loaded at startup — never
  inline strings.
- Each pipeline stage is runnable in isolation from `src/scripts/stage-*.ts`
  against `fixtures/sample_60s.mp3` (`npm run stage:analyze` etc.), so one stage
  can be demoed or debugged alone.
- The whole product over HTTP: `npm run dev`, then `npm run e2e:localize --
  --password=...` (account from `ADMIN_PASSWORD=... npm run create-admin --
  e2e@local.test --create`). `npm run localize:promote-demo -- <jobId>` makes a
  finished job the public `/demo`. The integration suite stubs the stages through
  the `Stages` seam in `localize.service.ts`. If 5432 is taken by another
  project's Postgres, start ours with `PG_PUBLISHED_PORT=5433 docker compose up -d
  postgres` and run `PG_PORT=5433 npm run test:integration` — never migrate into
  someone else's server.
- Log token usage and latency per Gemini call via `request.log`. A 60–90 s clip must
  complete in < 2 min for the demo.
- Gemini/GCP settings go through `src/config/index.ts` like everything else
  (rule 3 below). Model id and API surface are single constants in `src/lib/gemini.ts`.
- Target language: Hindi only. A second language is a NICE after the pipeline is solid.
- Don't add features not in `docs/SPEC.md` without asking. Scope creep kills hackathons.
- If a Google API behaves differently from `docs/research.md`, say so immediately
  and update that file; never work around it silently.
- Before claiming anything works, run it and show the output.
- When unsure about a product decision, use AskUserQuestion rather than guessing.

---

# Fastify + TypeScript + PostgreSQL boilerplate

Cloned as the starting point for new projects. Keep these rules intact when
adding features; `README.md` has the long-form reasoning behind each one.

Two projects live in this repository:

- **the API** — this directory. Everything below applies to it.
- **the frontend** — `web/`, a Next.js 16 app. It has its OWN package.json,
  lockfile, tsconfig, eslint config, Dockerfile and `CLAUDE.md`. Read
  `web/CLAUDE.md` before touching anything under `web/`; none of the rules
  below apply there, and none of its rules apply here. Nothing imports across
  the boundary — the only contract between them is HTTP.

## Commands

- `npm run dev` — Node runs `.ts` directly (type stripping), no tsx/ts-node
- `npm run typecheck` — `tsc --noEmit`; run after any series of edits
- `npm run test:unit` — `app.inject()`, **no database required**
- `npm run test:integration` — needs Postgres up (`docker compose up -d`)
- `npm run lint` / `npm run lint:fix`
- `npm run db:generate` — generate a migration after editing `src/db/schema.ts`
- `.claude/bootstrap-plugins.sh` — **run once per machine after cloning**; installs
  the Claude Code plugins that `.claude/settings.json` enables (see below)

Before calling a change done: `npm run typecheck && npm run lint && npm run test:unit`.

For the frontend, `cd web && npm run typecheck && npm run lint && npm run build`.

The enabled plugins are `typescript-lsp` (wants the `typescript-language-server`
binary — the bootstrap script installs it), `security-guidance`,
`modern-web-guidance`, `mattpocock-skills`, `playwright` and `frontend-design`.
`settings.json` registers the marketplace but Claude Code does not auto-install
plugins from external sources, so a fresh clone reports them missing until the
bootstrap script runs.

## Conventions that differ from the obvious default

- **Relative imports carry the `.ts` extension** (`./user.service.ts`), not `.js`
  and not extensionless. `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`
  handle the build.
- **No enums, namespaces, or constructor parameter properties** — Node's type
  stripping cannot erase them.
- **`import type` is required** for type-only imports (`verbatimModuleSyntax`).
- `exactOptionalPropertyTypes` is on: pass an optional field by spreading
  (`...(x === undefined ? {} : { x })`), never as an explicit `undefined`.
- `noUncheckedIndexedAccess` is on: index access yields `T | undefined`.
- `no-console` is an ESLint error. Log through `request.log` / `app.log`.
- Prettier: 90 columns, double quotes, ES5 trailing commas.

## Architectural rules

**1. `fp()` means shared, plain means private.**
Everything in `src/plugins/` is wrapped in `fastify-plugin` so its decorators
reach the root instance. Nothing in `src/modules/` is wrapped — each route file
gets a child scope. Do not wrap a route plugin.

**2. Authorize by scope, not by repetition.**
Declare `app.addHook("onRequest", app.requireAuth)` once inside a nested
`register`, and every route in that scope inherits it. Never add a per-route
auth check where a scope would do. Per-route `preHandler: app.requireRole(...)`
is for *authorization* on top of that scope.

**3. Only `src/config/index.ts` reads `process.env`.**
Everything else imports `config`. Adding a variable means adding it to the Zod
schema there, to `.env.example`, and to `.env.test` if tests need it.

**4. `src/db/schema.ts` is the single table definition.**
Drizzle queries, migrations, and Better Auth all read it. Better Auth owns the
`users`/`sessions`/`accounts` tables — read them freely, but never write `email`
or anything on `accounts` outside Better Auth's own flows.

**5. Modules are `routes -> service -> repository`.**
Routes declare schemas and format responses. Services hold business rules and
take deps as a `Ctx` argument (never import a singleton pool). Repositories hold
Drizzle queries and a `toDto` mapper. Use the `new-module` skill to scaffold one.

**6. Zod schemas are the response serializer.**
A field absent from the response schema is *dropped* from the payload. If a
value is missing from a response, check the schema before debugging the handler.

**7. Errors: throw the helpers in `src/lib/errors.ts`** (`notFound`, `badRequest`,
`conflict`, …). The error handler plugin renders the envelope. Return
`ok(data, message)` / `paginated(...)` from `src/lib/api-response.ts` on success.

## The frontend contract

The four things about `web/` that this side has to hold up, in one place:

1. **`BETTER_AUTH_URL` is the FRONTEND's origin**, not an `api.` hostname. The
   Next app serves `/api/auth/*` on its own origin and forwards it here (a
   rewrite in development, Caddy in production), so the browser only ever sees
   one origin. Better Auth builds the Google `redirect_uri`, the verification
   link and the reset link from this value, and all three have to land where the
   session cookie is. `FRONTEND_URL` and `TRUSTED_ORIGINS` are that same origin.
2. **Better Auth's response shape is load-bearing.** `auth.routes.ts` returns it
   untouched because the frontend's Better Auth client SDK parses exactly that.
   Wrapping those routes in the house envelope breaks every SDK call.
3. **`GET /api/auth/providers` is public and is how the UI knows what to draw.**
   The frontend does not carry its own "is Google enabled" flag — it asks. Add a
   provider to `socialProviders` in `auth.factory.ts` and add it to that route's
   `social` list in the same edit, or the button never appears.
4. **`GET /api/auth/me` is the frontend's session read**, in the house envelope.
   Its DTO is mirrored in `web/src/lib/api/schemas.ts` and parsed at runtime —
   change the DTO here and change it there in the same commit.
5. **`details[]` on a 400 is a UI feature.** The frontend maps each
   `{ field, message }` onto the form field that produced it, so a strict-object
   rejection shows up under the input rather than as a toast.

## Security invariants — do not relax without being asked

- `role` is writable only through the admin-guarded `PATCH /:id`. Self-service
  bodies must not contain it, and the service for them must not accept it.
- Listing users is admin-only; the rows carry email addresses.
- Update bodies use `z.strictObject` so an unknown key is a 400, not a silent
  strip. Keep new update schemas strict.
- Never interpolate user input into SQL. Escape LIKE metacharacters (`%`, `_`,
  `\`) when building patterns — see `escapeLikePattern` in `user.repository.ts`.
