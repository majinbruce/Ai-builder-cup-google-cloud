import fp from "fastify-plugin";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import { config } from "../config/index.ts";
import { isAppError } from "../lib/errors.ts";
import type { ErrorDetail } from "../lib/api-response.ts";
import { redact } from "../lib/redact.ts";
import { captureRequestError } from "../instrument.ts";

interface Normalized {
  statusCode: number;
  message: string;
  isOperational: boolean;
  details?: ErrorDetail[];
}

/** Postgres error codes we translate into HTTP instead of leaking as a 500. */
const PG_ERRORS: Record<string, Normalized> = {
  "23505": { statusCode: 409, message: "Resource already exists", isOperational: true },
  "23503": {
    statusCode: 400,
    message: "Referenced resource does not exist",
    isOperational: true,
  },
  "23502": {
    statusCode: 400,
    message: "A required field is missing",
    isOperational: true,
  },
  "22P02": {
    statusCode: 400,
    message: "Malformed value in request",
    isOperational: true,
  },
};

/**
 * Normalises whatever was thrown into something with a usable status code.
 * Everything that isn't recognised is treated as a programmer error: it keeps
 * its 500 and its message is withheld in production.
 */
const normalize = (err: FastifyError): Normalized => {
  // Schema validation failed. Report every bad field at once — a client that
  // has to fix one field per round-trip will make four requests to learn four
  // things.
  if (hasZodFastifySchemaValidationErrors(err)) {
    return {
      statusCode: 400,
      message: "Validation failed",
      isOperational: true,
      details: err.validation.map((entry) => ({
        // instancePath is a JSON pointer ("/address/city"); clients want a
        // field path ("address.city").
        field: entry.instancePath.replace(/^\//, "").replace(/\//g, ".") || "(root)",
        message: entry.message ?? "Invalid value",
      })),
    };
  }

  // The *response* did not match its own schema. That is our bug, never the
  // caller's, so it must not come back as a 400.
  if (isResponseSerializationError(err)) {
    return {
      statusCode: 500,
      message: "Response did not match its schema",
      isOperational: false,
    };
  }

  if (isAppError(err)) {
    return {
      statusCode: err.statusCode,
      message: err.message,
      isOperational: true,
      ...(err.details ? { details: err.details } : {}),
    };
  }

  const pgError = typeof err.code === "string" ? PG_ERRORS[err.code] : undefined;
  if (pgError) return pgError;

  switch (err.code) {
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
    case "FST_ERR_CTP_INVALID_JSON_BODY":
      return {
        statusCode: 400,
        message: "Malformed JSON in request body",
        isOperational: true,
      };
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return { statusCode: 413, message: "Request body too large", isOperational: true };
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return {
        statusCode: 415,
        message: "Unsupported content type",
        isOperational: true,
      };
    default:
      break;
  }

  // Anything with a 4xx that reached here came from Fastify itself (or from an
  // AppError thrown by requireAuth/requireRole, handled above), so its message
  // is safe to pass through. Better Auth's own endpoints never reach this
  // handler: they return their own Response, which the catch-all forwards
  // verbatim.
  const statusCode = err.statusCode ?? 500;

  return {
    statusCode,
    message: err.message || "Internal server error",
    isOperational: statusCode < 500,
  };
};

export default fp(
  async (app) => {
    app.setErrorHandler(
      (err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
        const { statusCode, message, isOperational, details } = normalize(err);

        // request.log already carries reqId, method and url, so the log line only
        // needs what it cannot know.
        const log = statusCode >= 500 ? request.log.error : request.log.warn;

        log.call(
          request.log,
          {
            err,
            statusCode,
            isOperational,
            userId: request.user?.id ?? "anonymous",
            details: details === undefined ? undefined : redact(details),
          },
          "request-failed"
        );

        /**
         * Only the unexpected ones. An operational error — a 400 from
         * validation, a 404, a 409 from a unique constraint — is the API
         * working correctly, and sending those to Sentry buys a quota bill and
         * an alert channel nobody reads. What is left is genuinely "this
         * shouldn't happen", which is exactly what you want to be paged about.
         *
         * Not awaited: the user's response does not wait on a third party.
         */
        if (!isOperational) {
          captureRequestError(err, {
            requestId: request.id,
            method: request.method,
            url: request.routeOptions.url ?? request.url,
            userId: request.user?.id ?? "anonymous",
          });
        }

        // Never leak an unexpected error's message or stack in production.
        const safeToExpose = isOperational || !config.isProduction;

        reply.status(statusCode).send({
          statusCode: -1,
          message: safeToExpose
            ? message
            : "Something went wrong! Please try again later.",
          requestId: request.id,
          ...(details === undefined ? {} : { details }),
          ...(config.isProduction ? {} : { stack: err.stack }),
        });
      }
    );

    /**
     * Without this, an unknown route returns Fastify's own JSON shape and a
     * client parsing `statusCode: 0 | -1` breaks on the one response it is
     * most likely to hit by accident.
     */
    app.setNotFoundHandler((request, reply) => {
      reply.status(404).send({
        statusCode: -1,
        message: `Route ${request.method} ${request.url} not found`,
        requestId: request.id,
      });
    });
  },
  { name: "error-handler" }
);
