---
paths:
  - "db/**"
  - "src/db/**"
  - "drizzle.config.ts"
  - "src/scripts/migrate.ts"
---

# Schema and migrations

`src/db/schema.ts` is the only place a table is defined. Drizzle queries,
the generated SQL migrations, and Better Auth all read that one file.

## Never hand-write or hand-edit a migration

`db/migrations/` is generated output, and `db/migrations/meta/` is a journal
drizzle-kit maintains. Editing either by hand desynchronises the snapshot from
the SQL, and the next `db:generate` produces a broken diff. Settings deny edits
to that directory for this reason.

The loop is always:

1. Edit `src/db/schema.ts`.
2. `npm run db:generate` — drizzle-kit writes the SQL and updates the journal.
3. Read the generated SQL and check it does what you intended.
4. `npm run db:migrate` to apply it locally.

`npm run db:push` skips the migration file entirely. It is a local scratch tool
only — never use it as the way a schema change reaches a committed state.

## Better Auth owns three tables

`users`, `sessions`, and `accounts` are written by Better Auth during sign-up
and sign-in. Reading them from a repository is fine and is the point of sharing
one schema object. Do not add application writes to `users.email` or to anything
on `accounts`: an email changed by UPDATE bypasses verification, and email is
the key implicit account linking trusts.

Adding a column to `users` is fine. Adding one that Better Auth should populate
means declaring it in `src/modules/auth/auth.factory.ts` too, and deciding there
whether it is `input: false` — the flag that stops a sign-up body from setting
a field like `role`.

## Deletes cascade, and that is deliberate

`sessions` and `accounts` are `ON DELETE CASCADE` from `users`. Do not introduce
a soft-delete column as an alternative: Better Auth's session lookup does not
know about one, so a "deleted" user keeps authenticating with a live session.

## Migrations run before the app serves traffic

`src/scripts/migrate.ts` is a separate entrypoint. `server.ts` does not migrate
on boot — a deploy runs the migration step first. Keep it that way, so two app
replicas starting at once cannot race the same migration.
