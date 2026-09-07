import process from "node:process";
import { lt } from "drizzle-orm";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config/index.ts";
import { schema, sessions, verifications } from "../db/schema.ts";

/**
 * Deletes rows that are already dead: sessions past `expires_at`, and the
 * single-use verification tokens (email verification, password reset, OAuth
 * state + PKCE verifier) past theirs.
 *
 * Better Auth never removes these itself. It checks `expires_at` on read, so an
 * expired row is already harmless — but it is also permanent. Every sign-in,
 * every password-reset request and every abandoned Google redirect leaves one
 * behind forever. Nothing breaks; the tables just grow without limit, the
 * indexes on them get bigger and colder, and autovacuum spends progressively
 * more time on data that no query will ever read again. It is the kind of
 * problem that is invisible for a year and then annoying to fix under load.
 *
 * Deliberately a script on a schedule, not a setInterval inside the app:
 *
 *   - An in-process timer runs once per instance. That is fine at one instance
 *     and wrong at two, and the failure is silent duplicate work rather than an
 *     error anyone would see.
 *   - A DELETE that touches a large range holds locks and generates WAL. That
 *     belongs at 04:00 on a schedule you chose, not at whatever moment the
 *     process happened to boot.
 *
 * Run it from cron on the host (see deploy/README.md):
 *
 *   docker compose -f compose.prod.yml exec -T api node dist/scripts/prune-expired.js
 */

const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
});

const db = drizzle(pool, { schema });

const log = (message: string) => process.stdout.write(`${message}\n`);

/**
 * `now` is captured once and reused for both statements so the two deletes
 * agree on what "expired" means. Using NOW() twice would be correct too, just
 * not reproducible in the log line below.
 */
const now = new Date();

try {
  /**
   * No batching, on purpose. At the scale this boilerplate targets these
   * deletes are a few thousand rows at most, and a single statement is one
   * transaction and one WAL flush.
   *
   * If you ever run this against a table that has gone years without a prune,
   * do the first pass in chunks instead — a multi-million-row DELETE in one
   * transaction bloats WAL and holds the table's dead tuples until it commits:
   *
   *   DELETE FROM sessions WHERE id IN (
   *     SELECT id FROM sessions WHERE expires_at < NOW() LIMIT 10000
   *   );
   *
   * in a loop until it reports zero. After that, the nightly run keeps up.
   */
  const prunedSessions = await db.delete(sessions).where(lt(sessions.expiresAt, now));
  const prunedVerifications = await db
    .delete(verifications)
    .where(lt(verifications.expiresAt, now));

  log(
    `Pruned ${prunedSessions.rowCount ?? 0} expired session(s) and ` +
      `${prunedVerifications.rowCount ?? 0} expired verification(s) ` +
      `older than ${now.toISOString()}.`
  );
} catch (err) {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
} finally {
  await pool.end();
}
