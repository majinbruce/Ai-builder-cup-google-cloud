/**
 * FIRST, and it has to stay first.
 *
 * Sentry instruments `http` and `pg` by patching them as they are loaded, so it
 * only sees anything if it initialises before those modules exist. ESM
 * evaluates imports depth-first in declaration order, so this line — and only
 * this line being above the others — is what guarantees that. Moving it down
 * does not break the build or fail a test; it quietly costs you request context
 * on every error report.
 */
import { captureFatal, flushSentry } from "./instrument.ts";

import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { buildApp } from "./app.ts";
import { config } from "./config/index.ts";
import {
  failRunningJobs,
  failStaleJobs,
  REAP_INTERVAL_MS,
} from "./modules/localize/localize.service.ts";

const app = await buildApp();

/**
 * Fail fast on boot. The pool itself connects lazily, so without this the first
 * user request would be the thing that discovers the database is unreachable —
 * and a deploy would go green on a broken instance.
 */
try {
  await app.pg.waitForConnection();
} catch (err) {
  app.log.fatal({ err }, "Database is mandatory — refusing to start");
  await app.close();
  process.exit(1);
}

/**
 * Fastify's close() already runs every plugin's onClose hook (which is where
 * the pg pool shuts itself down) and waits for in-flight requests, so graceful
 * shutdown is mostly just calling it. The hard timeout stays: it guarantees the
 * process dies even if a socket refuses to.
 */
let shuttingDown = false;

/** The orphan reaper's timer, started after listen and stopped on shutdown. */
let reaper: NodeJS.Timeout | undefined;

/**
 * `exitCode` is what a clean shutdown exits with: 0 for a signal, 1 when the
 * trigger was a crash (see unhandledRejection below). Without it, a rejection
 * that drained gracefully would exit 0 and look like a deliberate stop to
 * anything counting non-zero exits — the restart policy does not care, but
 * monitoring does.
 */
const shutdown = async (signal: string, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info(`${signal} received — shutting down gracefully`);

  // The drain is part of shutdown but not part of closing, so the budget is the
  // sum: SHUTDOWN_TIMEOUT_MS keeps meaning "how long app.close() gets".
  const forceExit = setTimeout(() => {
    app.log.error("Shutdown timed out — forcing exit");
    process.exit(1);
  }, config.server.shutdownDrainMs + config.server.shutdownTimeoutMs);

  forceExit.unref();

  try {
    /**
     * Stop reporting ready, then wait, and only then close.
     *
     * A load balancer finds out this instance is going away by polling
     * /health/ready, and it polls on an interval — so between SIGTERM and the
     * next poll it is still sending new requests here. Closing immediately
     * means those arrive at a socket that is already refusing: connection reset
     * for the user, 502 in the proxy log, on every single deploy.
     *
     * So the order is: fail readiness, give the balancer long enough to notice
     * and take this instance out of rotation (SHUTDOWN_DRAIN_MS — set it to a
     * couple of poll intervals), and then close. app.close() still waits for
     * everything already in flight, so nothing in progress is dropped either.
     */
    app.lifecycle.beginDraining();

    if (config.server.shutdownDrainMs > 0) {
      app.log.info(
        { drainMs: config.server.shutdownDrainMs },
        "draining — /health/ready now reports 503, still serving in-flight requests"
      );
      await sleep(config.server.shutdownDrainMs);
    }

    clearInterval(reaper);

    // Before close, while the pool is still open. app.close() waits for
    // requests, not for localize jobs running after their POST returned, so
    // whatever is still running dies with this process — say so on the rows now,
    // rather than leaving owners polling until the reaper notices.
    await failRunningJobs({ db: app.db, log: app.log }).catch((err: unknown) => {
      app.log.error({ err }, "could not mark running localize jobs failed");
    });

    await app.close();
    await flushSentry();
    process.exit(exitCode);
  } catch (err) {
    app.log.error({ err }, "Error during shutdown");
    await flushSentry();
    process.exit(1);
  }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/**
 * The process is in an unknown state after an uncaught exception, so log and
 * exit; a supervisor (k8s, ECS, systemd, pm2) is expected to restart it. A
 * rejected promise gets the same treatment but goes through shutdown first, so
 * in-flight requests still get their responses.
 */
process.on("uncaughtException", (err) => {
  app.log.fatal({ err }, "Uncaught exception — exiting");
  // Report before dying, or the one class of error nobody is watching for is
  // also the one that never reaches the dashboard. captureFatal resolves
  // immediately when Sentry is not configured.
  void captureFatal(err).finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  app.log.fatal({ err: reason }, "Unhandled rejection — exiting");
  // The .finally is the backstop for the case where a shutdown is already in
  // flight and this call returns immediately.
  void captureFatal(reason)
    .then(() => shutdown("unhandledRejection", 1))
    .finally(() => process.exit(1));
});

try {
  await app.listen({ port: config.server.port, host: config.server.host });
} catch (err) {
  app.log.error({ err }, "Failed to start server");
  process.exit(1);
}

/**
 * Localization jobs run in-process, so a job that was mid-pipeline when a
 * process died will never finish on its own (SPEC section g). Reaped here rather
 * than in an onReady hook because the unit suite builds the app with no
 * database; after listen, because a failure to reap is worth a log line and not
 * worth refusing traffic over; and then on a timer, because a job killed moments
 * before this boot is not stale yet (see failStaleJobs).
 */
const reap = () =>
  failStaleJobs({ db: app.db, log: app.log }).catch((err: unknown) => {
    app.log.error({ err }, "could not reap orphaned localize jobs");
  });

await reap();

if (!shuttingDown) {
  reaper = setInterval(() => void reap(), REAP_INTERVAL_MS);
  reaper.unref();
}
