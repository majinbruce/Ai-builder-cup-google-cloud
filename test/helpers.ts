import { buildApp, type App } from "../src/app.ts";
import type { Mailer } from "../src/lib/mailer.ts";

/**
 * Builds an app that never listens on a port. app.inject() pushes a real
 * request through the entire lifecycle — hooks, validation, serialization,
 * error handler — in memory, so these tests exercise the same code path
 * production does without a socket, a port, or supertest.
 *
 * The pg pool connects lazily, so everything that fails before touching the
 * database (validation, auth, 404s) is testable with no database running —
 * which is exactly what the `unit` project in vitest.config.ts runs, and why
 * only the `integration` project carries a globalSetup.
 */
export const buildTestApp = async (mailer?: Mailer): Promise<App> => {
  const app = await buildApp(mailer === undefined ? {} : { mailer });
  await app.ready();
  return app;
};
