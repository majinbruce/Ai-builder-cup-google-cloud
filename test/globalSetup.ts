import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";
import pg from "pg";

const run = promisify(execFile);

/**
 * Runs once per `vitest run`, before any test file is imported.
 *
 * Strategy: a real Postgres, in a separate `app_test` DATABASE on the same
 * server docker-compose already starts (created by db/init/01-create-test-db.
 * sql). Not an ephemeral container per run, and not a mocked adapter.
 *
 *   - Real, because the things worth testing here are things a fake cannot be
 *     honest about: ON DELETE CASCADE revoking sessions, the unique index that
 *     produces the 23505 the error handler maps to 409, and Better Auth's own
 *     queries against the tables in src/db/schema.ts.
 *   - Not a container per run, because Testcontainers means a large dependency,
 *     a Docker socket in CI, and seconds of startup — to reach a database
 *     `docker compose up` has already given you.
 *   - Separate database rather than separate schema, because the generated
 *     DDL is unqualified and would need a search_path dance.
 *
 * Test files still run in PARALLEL. Isolation comes from every test minting its
 * own identity with a random email (see helpers/auth.ts), not from serialising
 * the suite or truncating between files.
 */
export default async function setup() {
  const database = process.env["PG_DATABASE"] ?? "app_test";

  try {
    await run("node", ["src/scripts/migrate.ts"], {
      env: { ...process.env, NODE_ENV: "test" },
    });
  } catch (err) {
    throw new Error(
      `Could not migrate the test database "${database}". ` +
        "Is Postgres running? `docker compose up -d postgres` creates it.",
      { cause: err }
    );
  }

  /**
   * One clean slate per run. Not per file — parallel files would truncate each
   * other's rows out from under them. CASCADE reaches sessions and accounts
   * through their foreign keys.
   */
  const pool = new pg.Pool({
    host: process.env["PG_HOST"] ?? "127.0.0.1",
    port: Number(process.env["PG_PORT"] ?? 5432),
    user: process.env["PG_USER"] ?? "postgres",
    password: process.env["PG_PASSWORD"] ?? "postgres",
    database,
  });

  try {
    await pool.query("TRUNCATE users, verifications RESTART IDENTITY CASCADE");
  } finally {
    await pool.end();
  }
}
