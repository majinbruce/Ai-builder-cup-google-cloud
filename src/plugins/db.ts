import fp from "fastify-plugin";
import pg from "pg";
import type { Pool as PgPool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { config } from "../config/index.ts";
import { schema } from "../db/schema.ts";

const { Pool } = pg;

/**
 * `app.db` is a Drizzle instance bound to src/db/schema.ts, so a query is
 * checked against the real column types at compile time and a renamed column
 * is a type error rather than a runtime 500.
 *
 *   await db.select().from(users).where(eq(users.id, id));
 *   await db.query.users.findFirst({ where: eq(users.id, id) });
 *   await db.transaction(async (tx) => { ... });          // rolls back on throw
 *   await db.execute(sql`SELECT 1`);                      // raw, still typed
 */
export type Database = NodePgDatabase<typeof schema>;

/**
 * The driver underneath, still reachable — Drizzle is a query builder over the
 * pool, not a replacement for it.
 *
 * This is the escape hatch, and it is here on purpose: recursive CTEs, `COUNT(*)
 * OVER()`, `EXPLAIN ANALYZE` and one-off maintenance statements are all easier
 * as SQL text than as a builder expression, and pretending otherwise is how an
 * ORM starts costing more than it saves. `pg.query()` keeps the slow-query
 * logging and the parameterisation; string interpolation of user input is still
 * the one rule with no exceptions.
 */
export interface PgSupport {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
  withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  waitForConnection(): Promise<void>;
  pool: PgPool;
}

/**
 * Declaration merging: this teaches TypeScript that every FastifyInstance —
 * and therefore `request.server`, and `this` inside a handler — has `.db`.
 * Without it, `app.db` is a compile error even though it exists at runtime.
 */
declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    pg: PgSupport;
  }
}

const SLOW_QUERY_MS = 500;
const MAX_CONNECT_RETRIES = 5;
const RETRY_DELAY_MS = 5_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim();

/**
 * fp() is what makes `app.db` visible to the whole app.
 *
 * A plain plugin runs inside a child instance, so anything it decorates dies
 * with that child. fp() says "run me against the parent" — which is exactly
 * right for a shared connection pool and exactly wrong for, say, a route
 * group's auth hook.
 */
export default fp(
  async (app) => {
    // A pool, never a single client — one client serialises every request and
    // dies permanently on a dropped connection.
    const pool = new Pool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      max: config.db.max,
      idleTimeoutMillis: config.db.idleTimeoutMillis,
      connectionTimeoutMillis: config.db.connectionTimeoutMillis,
    });

    // Idle-client errors must not crash the process; the pool replaces the client.
    pool.on("error", (err) => {
      app.log.error({ err }, "Unexpected error on idle PostgreSQL client");
    });

    /**
     * Logs slow queries so a regression shows up before users report it.
     * Parameters are never logged — they routinely contain personal data.
     */
    const query = async <T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[]
    ): Promise<QueryResult<T>> => {
      const startedAt = process.hrtime.bigint();

      try {
        const result = await pool.query<T>(sql, params as unknown[]);
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

        if (durationMs > SLOW_QUERY_MS) {
          app.log.warn(
            {
              durationMs: Number(durationMs.toFixed(2)),
              rows: result.rowCount,
              sql: oneLine(sql),
            },
            "slow-query"
          );
        }

        return result;
      } catch (err) {
        app.log.error({ err, sql: oneLine(sql) }, "query-failed");
        throw err;
      }
    };

    /**
     * Drizzle is given a PROXY of the pool rather than the pool itself, so that
     * every query it runs — and every query Better Auth's adapter runs through
     * it — goes through the timing and error logging above.
     *
     * The alternative, Drizzle's own `logger` option, only sees a statement on
     * its way out: it cannot time it, cannot know how many rows came back, and
     * logs every query rather than the slow ones. Instrumenting the driver
     * catches everything above it for free, which is the point of Drizzle being
     * a thin layer over pg rather than its own client.
     */
    const instrumentedPool = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === "query") return query;

        const value: unknown = Reflect.get(target, prop, receiver);
        // Rebound to the pool: pg's methods are not arrow functions, so a bare
        // reference read through the proxy would lose `this`.
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });

    const db = drizzle(instrumentedPool, { schema });

    /**
     * Runs a set of statements in a single transaction, rolling back on any
     * throw and always releasing the client. This is the RAW version, for the
     * escape hatch; Drizzle queries use `db.transaction()`, which does the same
     * thing with the builder.
     */
    const withTransaction = async <T>(
      fn: (client: PoolClient) => Promise<T>
    ): Promise<T> => {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    };

    /**
     * Retries on boot because the database container is often not ready yet
     * when the app starts. This throws instead of exiting the process: the
     * decision to die belongs to server.ts, so tests can build an app without
     * a database and still exercise validation, auth and error handling.
     */
    const waitForConnection = async (): Promise<void> => {
      for (let attempt = 1; attempt <= MAX_CONNECT_RETRIES; attempt += 1) {
        try {
          const client = await pool.connect();
          try {
            await client.query("SELECT 1");
          } finally {
            client.release();
          }
          app.log.info("Connected to PostgreSQL");
          return;
        } catch (err) {
          app.log.error(
            { err, attempt, of: MAX_CONNECT_RETRIES },
            "PostgreSQL connection failed"
          );

          if (attempt === MAX_CONNECT_RETRIES) {
            throw new Error("Could not connect to PostgreSQL", { cause: err });
          }

          await sleep(RETRY_DELAY_MS);
        }
      }
    };

    app.decorate("db", db);
    app.decorate("pg", { query, withTransaction, waitForConnection, pool });

    /**
     * The pool now closes itself. app.close() runs every plugin's onClose hook
     * in reverse registration order, so server.ts never learns that a database
     * exists — this is the payoff of owning a resource inside a plugin.
     */
    app.addHook("onClose", async () => {
      await pool.end();
      app.log.info("PostgreSQL pool closed");
    });
  },
  { name: "db" }
);
