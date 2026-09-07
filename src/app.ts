import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { config } from "./config/index.ts";
import type { Mailer } from "./lib/mailer.ts";

import configPlugin from "./plugins/config.ts";
import lifecyclePlugin from "./plugins/lifecycle.ts";
import errorHandlerPlugin from "./plugins/error-handler.ts";
import dbPlugin from "./plugins/db.ts";
import securityPlugin from "./plugins/security.ts";
import authPlugin from "./plugins/auth.ts";
import swaggerPlugin from "./plugins/swagger.ts";

import healthRoutes from "./modules/health/health.routes.ts";
import authRoutes from "./modules/auth/auth.routes.ts";
import userRoutes from "./modules/user/user.routes.ts";

/**
 * An upstream `x-request-id` is attacker-controlled until proven otherwise.
 *
 * Whatever comes back from here is stamped on every log line for the request as
 * `reqId`, echoed in the `x-request-id` response header, and included in the
 * error envelope — so an unfiltered header is a write primitive into your log
 * store. A 2KB value bloats every line of a request; newlines forge log
 * entries in anything that parses per-line; and the value lands in dashboards
 * and alert payloads that may render it.
 *
 * The filter is a shape check, not sanitisation: an id that does not look like
 * an id is discarded and a fresh UUID issued, so a caller can never choose the
 * bytes. The charset covers UUIDs, W3C traceparent, and the hex/base64url ids
 * that nginx, Envoy, ALB and Cloudflare generate.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._~+/=-]{1,128}$/;

const acceptUpstreamRequestId = (
  header: string | string[] | undefined
): string | null => {
  // A repeated header arrives as an array. Two upstream ids means one of them
  // is not upstream's, so trust neither.
  if (typeof header !== "string") return null;

  return REQUEST_ID_PATTERN.test(header) ? header : null;
};

export interface BuildAppOptions {
  /** Injected by the tests; production uses the console mailer by default. */
  mailer?: Mailer;
}

/**
 * Builds a fully configured app that is NOT listening on a port yet.
 *
 * This is the same app.js / server.js split as before, but in Fastify it buys
 * more: an app that isn't listening can still be sent real HTTP requests in
 * memory via app.inject(), which is how the whole test suite works.
 */
export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    // The old request_id_middleware, in one option. Honour an upstream id when
    // a gateway already assigned one, so a trace survives the hop — but only
    // if it looks like an id. See acceptUpstreamRequestId below.
    genReqId: (req) =>
      acceptUpstreamRequestId(req.headers["x-request-id"]) ?? randomUUID(),
    bodyLimit: config.server.bodyLimit,
    /**
     * How far to trust X-Forwarded-For. Configured, not hard-coded `true`:
     * blanket trust means anyone who can reach the process directly can name
     * their own `request.ip`, and `request.ip` is the rate-limit key in front
     * of sign-in and password reset. Set TRUST_PROXY to the number of proxy
     * hops you actually run (see config/index.ts).
     */
    trustProxy: config.server.trustProxy,
    logger: {
      level: config.logLevel,
      /**
       * The old request_logger_middleware is gone: Fastify logs every request
       * and response with reqId and responseTime built in. All that is left to
       * configure is what must never reach the log file.
       */
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.body.password",
          "res.headers['set-cookie']",
        ],
        censor: "[REDACTED]",
      },
      // pino-pretty makes local logs readable. In production we emit raw JSON,
      // which is what log aggregators (Datadog, CloudWatch, Loki) want.
      //
      // Spread rather than `transport: undefined` — `exactOptionalPropertyTypes`
      // treats "key absent" and "key present but undefined" as different things,
      // and Pino's types only accept the former.
      ...(config.isProduction
        ? {}
        : {
            transport: {
              target: "pino-pretty",
              options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
            },
          }),
    },
  }).withTypeProvider<ZodTypeProvider>();

  /**
   * These two lines are what let a route declare a Zod schema directly. The
   * validator turns `body: someZodSchema` into request validation; the
   * serializer turns `response: { 200: schema }` into a compiled
   * fast-json-stringify function — which is both faster than JSON.stringify
   * and, more importantly, drops every field the schema does not mention.
   */
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  /**
   * Registration order is the execution order of the hooks these plugins add.
   * The error handler goes first so that a failure in any later plugin is
   * already reported in the standard envelope.
   *
   * Every one of these is wrapped in fp(), so what they decorate lands on THIS
   * instance and is visible to everything registered after them. The route
   * plugins below are deliberately NOT wrapped: each gets its own child scope,
   * which is why user.routes.ts can add an auth hook without leaking it to
   * /health.
   */
  /**
   * Send the request id back. Fastify puts it in every log line already; this
   * is what lets a user paste an id from an error response into a log search.
   */
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  await app.register(configPlugin);
  await app.register(lifecyclePlugin);
  await app.register(errorHandlerPlugin);
  await app.register(dbPlugin);
  await app.register(securityPlugin);
  // Spread rather than passing `undefined`: exactOptionalPropertyTypes treats
  // an absent key and a key set to undefined as different types.
  await app.register(authPlugin, {
    ...(options.mailer === undefined ? {} : { mailer: options.mailer }),
  });

  if (!config.isProduction) {
    await app.register(swaggerPlugin);
  }

  // The URL prefix lives here, not inside the route files — so a module can be
  // remounted at a different version without editing it.
  await app.register(healthRoutes, { prefix: "/health" });

  /**
   * Deliberately NOT /api/v1/auth. This prefix has to agree with Better Auth's
   * own basePath, with the Better Auth client SDK's default, and with the
   * redirect URI registered in the Google Cloud Console — so versioning it
   * would turn a routine API version bump into a Google Console change and a
   * breaking change for every SDK consumer. It is a documented exception to
   * the /api/v1 convention, and config.auth.basePath is its single source.
   */
  await app.register(authRoutes, { prefix: config.auth.basePath });
  await app.register(userRoutes, { prefix: "/api/v1/users" });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
