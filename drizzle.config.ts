import { defineConfig } from "drizzle-kit";
import { config } from "./src/config/index.ts";

/**
 * drizzle-kit's config. This is a BUILD-TIME tool, not part of the running app:
 * nothing in src/ imports this file, and drizzle-kit is a devDependency that
 * never reaches the runtime image.
 *
 * Its one job here is generating SQL. `npm run db:generate` diffs
 * src/db/schema.ts against the migrations already in db/migrations and writes
 * the difference as a new numbered .sql file plus a journal entry.
 *
 * Applying those files is deliberately NOT drizzle-kit's job — see
 * src/scripts/migrate.ts, which uses drizzle-orm's own migrator so that
 * production can run migrations without dev dependencies installed.
 *
 * Credentials come from the same parsed config the app uses, so there is no
 * second place that has to be told where the database is. Run it with
 * NODE_ENV=test to point it at the test database.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./db/migrations",
  dbCredentials: {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    ssl: false,
  },
  // Keeps `db:push` and introspection away from Postgres' own catalogs.
  schemaFilter: ["public"],
  // Prints the SQL and asks before touching the database on `db:push`.
  verbose: true,
  strict: true,
});
