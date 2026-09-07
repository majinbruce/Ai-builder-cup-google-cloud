import path from "node:path";
import process from "node:process";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { config } from "../config/index.ts";

/**
 * Applies every pending migration in db/migrations, in journal order, each one
 * inside a transaction, recording what it applied. Re-running is a no-op.
 *
 * Why this file still exists instead of `drizzle-kit migrate`:
 *
 *   - drizzle-kit is a devDependency. The runtime image is built with
 *     `npm ci --omit=dev`, so `drizzle-kit migrate` is not available in the
 *     container that actually deploys. `migrate()` ships inside drizzle-orm,
 *     which is a production dependency and already installed.
 *   - It reads the same parsed config as the app, so there is no second place
 *     that has to be told where the database is.
 *
 * GENERATING migrations is drizzle-kit's job and stays that way:
 * `npm run db:generate` after every change to src/db/schema.ts.
 */

const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, "../../db/migrations");

const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
});

const log = (message: string) => process.stdout.write(`${message}\n`);

try {
  // Bookkeeping lives in its own `drizzle` schema, in a __drizzle_migrations
  // table, so it never collides with an application table.
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  log(`Migrations up to date (${config.db.database}).`);
} catch (err) {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
} finally {
  await pool.end();
}
