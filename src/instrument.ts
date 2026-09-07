import * as Sentry from "@sentry/node";
import { config } from "./config/index.ts";

/**
 * Sentry setup, and the two helpers that let the rest of the app stay unaware
 * of whether Sentry exists.
 *
 * With no SENTRY_DSN this module initialises nothing, sends nothing and opens
 * no socket — the same "configure it or it does not exist" shape as the Google
 * provider, so a fresh clone needs no account anywhere. Every export below is a
 * no-op in that case, which is why no call site has an `if` around it.
 *
 * IMPORTANT: this module must be evaluated before `http`, `pg` and Fastify are
 * loaded — Sentry instruments those by patching them as they load. That is
 * arranged by making it the first import in server.ts; see the comment there.
 */

const enabled = config.sentry.dsn !== null;

if (config.sentry.dsn) {
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    tracesSampleRate: config.sentry.tracesSampleRate,

    /**
     * Off, deliberately. `sendDefaultPii` attaches request headers, cookies and
     * IP addresses to every event — and the cookie header is a live session
     * token, which would then be sitting in a third-party dashboard readable by
     * everyone you invite to the project. The error handler attaches the user
     * id and request id explicitly instead, which is what you actually need to
     * chase a report, and neither of them is a credential.
     */
    sendDefaultPii: false,

    ...(config.sentry.release === undefined ? {} : { release: config.sentry.release }),
  });
}

/**
 * Report an error that is about to kill the process.
 *
 * Sentry batches events and sends them in the background, so a plain
 * captureException followed by process.exit() loses the report — the process is
 * gone before the request leaves. flush() is what waits for the queue to
 * actually drain, and the timeout is what stops a dead network from turning a
 * crash into a hang.
 */
export const captureFatal = async (err: unknown): Promise<void> => {
  if (!enabled) return;

  Sentry.captureException(err);
  await Sentry.flush(2_000);
};

/** Drain the queue during graceful shutdown. Never throws, never hangs. */
export const flushSentry = async (): Promise<void> => {
  if (!enabled) return;

  await Sentry.flush(2_000);
};

/**
 * Report a request that failed with an unexpected 500. Fire-and-forget: this is
 * called from the error handler, and the user's response must not wait on a
 * third party.
 *
 * `scope` here is per-call, not global — Sentry's `withScope` isolates the tags
 * so two concurrent requests cannot end up attributed to each other's user.
 */
export const captureRequestError = (
  err: unknown,
  context: { requestId: string; method: string; url: string; userId: string }
): void => {
  if (!enabled) return;

  Sentry.withScope((scope) => {
    scope.setTag("requestId", context.requestId);
    scope.setTag("method", context.method);
    // The route as matched, so Sentry groups /users/:id rather than treating
    // every id as its own endpoint.
    scope.setTag("route", context.url);
    scope.setUser({ id: context.userId });
    Sentry.captureException(err);
  });
};
