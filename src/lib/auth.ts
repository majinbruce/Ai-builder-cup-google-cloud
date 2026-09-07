import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createAuth, type AuthLogger } from "../modules/auth/auth.factory.ts";
import { config } from "../config/index.ts";
import { schema } from "../db/schema.ts";
import type { Mailer } from "./mailer.ts";

/**
 * ============================================================================
 * The Better Auth CLI entrypoint. THE RUNNING APP NEVER IMPORTS THIS.
 * ============================================================================
 *
 * The live instance is built in plugins/auth.ts against the real pool and the
 * real mailer. This file exists for two consumers that need a fully-formed
 * instance without a running server:
 *
 *   1. `npx auth@latest generate`, which statically imports an auth instance to
 *      derive the schema from it. The CLI looks for `auth.ts` in ./, ./lib,
 *      ./src/lib and friends — hence the location and the name. With the
 *      Drizzle adapter it now emits a Drizzle schema rather than raw SQL, so
 *      after a Better Auth upgrade you diff its output against
 *      src/db/schema.ts and then run `npm run db:generate` for the migration.
 *
 *   2. TypeScript. `typeof auth.$Infer.Session` is how plugins/auth.ts types
 *      `request.user` and `request.session`, so those types are derived from
 *      the configuration rather than hand-copied beside it. Add a field to
 *      `additionalFields` and the request types follow with no second edit.
 *
 * Neither consumer runs a query or sends an email, so the dependencies below
 * are inert: the pg Pool connects lazily and is never asked to, and the logger
 * and mailer are no-ops.
 */

const noopLogger: AuthLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const noopMailer: Mailer = { send: async () => undefined };

export const auth = createAuth({
  // Never connected: `new Pool()` only stores config until the first query, and
  // drizzle() does not touch it at construction either.
  db: drizzle(
    new pg.Pool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
    }),
    { schema }
  ),
  mailer: noopMailer,
  log: noopLogger,
});
