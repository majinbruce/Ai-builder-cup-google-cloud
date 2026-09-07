import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { fromNodeHeaders } from "better-auth/node";
import { config } from "../../config/index.ts";
import { errorEnvelope, ok, successEnvelope } from "../../lib/api-response.ts";
import { badRequest } from "../../lib/errors.ts";
import { requireUser } from "../../lib/require-user.ts";
import { authProvidersDtoSchema, meDtoSchema } from "./auth.schemas.ts";

/**
 * Headers that must NOT be copied from Better Auth's Response onto the Fastify
 * reply.
 *
 * @fastify/compress is registered globally and may re-encode the body after we
 * return. If we copy a content-length measured before compression, or a
 * content-encoding that no longer describes the bytes on the wire, the client
 * gets a truncated or undecodable response. Fastify recomputes both correctly
 * once we leave them alone.
 */
const HEADERS_SET_BY_FASTIFY = new Set(["content-length", "content-encoding"]);

const authRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Scoped to this plugin only (Fastify encapsulates content-type parsers just
   * like hooks), and it exists for one specific failure:
   *
   * Better Auth has POST endpoints with no request body — /sign-out is the
   * obvious one. Fastify's stock JSON parser rejects an empty body with
   * FST_ERR_CTP_EMPTY_JSON_BODY, which our error handler turns into a 400
   * BEFORE the handler below ever runs. Treating "" as "no body" fixes it
   * without loosening JSON parsing anywhere else in the app.
   */
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      if (body === "") {
        done(null, undefined);
        return;
      }

      try {
        done(null, JSON.parse(body as string) as unknown);
      } catch {
        /**
         * A bare SyntaxError from JSON.parse carries no statusCode, so passing
         * it straight through makes malformed JSON a 500. Fastify's stock
         * parser raises FST_ERR_CTP_INVALID_JSON_BODY (a 400); replacing that
         * parser means replacing that behaviour too, and badRequest() is this
         * codebase's way of saying the same thing.
         */
        done(badRequest("Malformed JSON in request body"), undefined);
      }
    }
  );

  /**
   * ========================================================================
   * The whole Better Auth surface, mounted as one catch-all.
   * ========================================================================
   *
   * Everything under /api/auth/* — /sign-up/email, /sign-in/email, /sign-out,
   * /verify-email, /request-password-reset, /reset-password, /get-session,
   * /list-sessions, /revoke-session, /sign-in/social, /callback/google — is
   * routed by Better Auth's own router, not by Fastify. This handler is the
   * bridge: Fastify speaks Node req/res, Better Auth speaks WHATWG
   * Request/Response, so we translate in both directions.
   *
   * Deliberately no `response` schema. Better Auth returns its own JSON shape
   * ({ code, message } on failure), and the Better Auth client SDK on the
   * frontend parses exactly that. Wrapping these in this codebase's
   * { statusCode, message, data } envelope would break every SDK method. This
   * is the one documented exception to the "one envelope for the whole API"
   * rule — see the README.
   */
  app.route({
    method: ["GET", "POST"],
    url: "/*",
    /**
     * A loose ceiling that only catches abuse: the frontend polls /get-session
     * on navigation, so a tight limit here would break normal use. The tight,
     * path-aware limits on sign-in and password reset live in Better Auth's own
     * rateLimit.customRules (see auth.factory.ts) — it can tell those endpoints
     * apart, and Fastify, seeing one catch-all route, cannot.
     */
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    schema: {
      tags: ["auth"],
      summary: "Better Auth handler (sign-up, sign-in, OAuth, sessions)",
      description:
        "Served by Better Auth's own router. Responses use Better Auth's " +
        "shape rather than the standard envelope, because the Better Auth " +
        "client SDK depends on it.",
    },
    handler: async (request, reply) => {
      /**
       * Built from the configured baseURL, NOT from the incoming Host header.
       * Host is attacker-controlled, and Better Auth derives absolute URLs
       * (including the OAuth redirect_uri) from what it is given here.
       */
      const url = new URL(request.url, config.auth.baseUrl);

      const authRequest = new Request(url, {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        // Fastify already parsed the body; hand it back as JSON. Absent for GET
        // and for the empty-body POSTs handled by the parser above.
        ...(request.body === undefined || request.body === null
          ? {}
          : { body: JSON.stringify(request.body) }),
      });

      const response = await app.auth.handler(authRequest);

      reply.status(response.status);

      for (const [key, value] of response.headers) {
        // Set-Cookie needs the special handling below; skip it here so it is
        // not also copied as a single flattened value.
        if (key === "set-cookie" || HEADERS_SET_BY_FASTIFY.has(key)) continue;
        reply.header(key, value);
      }

      /**
       * The one that bites everybody, including Better Auth's own Fastify
       * example: a sign-in sets SEVERAL cookies (session token, and depending
       * on flow a session-data or don't-remember cookie). Iterating
       * `response.headers` yields Set-Cookie once, comma-joined, and a browser
       * will not reliably split that back apart — you get a session that
       * silently never persists.
       *
       * getSetCookie() is the standard accessor that preserves them
       * individually, and Fastify accumulates repeated set-cookie calls into an
       * array, so each one is emitted as its own header line.
       */
      for (const cookie of response.headers.getSetCookie()) {
        reply.header("set-cookie", cookie);
      }

      // A 204/302 has no body; sending "" would set a bogus content-length.
      return reply.send(response.body ? await response.text() : null);
    },
  });

  /**
   * ========================================================================
   * What this API can actually authenticate with. Public, and deliberately so.
   * ========================================================================
   *
   * The sign-in screen has to decide whether to draw a "Continue with Google"
   * button before anyone has signed in, and only this process knows the answer
   * — the provider is registered only when both Google credentials are present
   * (see auth.factory.ts). Duplicating that as a flag in the frontend's own
   * environment means two settings that must agree, and the failure when they
   * do not is a button that 400s in production.
   *
   * Nothing here is a secret. It is the set of front doors the building has,
   * which anybody can see by looking at the sign-in page anyway — the client
   * IDs, secrets and everything else stay on this side.
   *
   * Registered AFTER the catch-all above, and it still wins: Fastify's router
   * matches static segments ahead of wildcards regardless of declaration order,
   * so /api/auth/providers reaches this handler rather than Better Auth's `/*`.
   * `/me` below works the same way.
   */
  app.get(
    "/providers",
    {
      schema: {
        tags: ["auth"],
        summary: "Which sign-in methods this deployment offers",
        description:
          "Public. The frontend renders its sign-in screen from this, so the " +
          "UI cannot disagree with the server about which providers exist.",
        response: { 200: successEnvelope(authProvidersDtoSchema) },
      },
    },
    async () => {
      return ok(
        {
          // Add a provider to auth.factory.ts's socialProviders and it belongs
          // here in the same edit — this list is the contract the UI reads.
          social: config.auth.google ? ["google" as const] : [],
          emailAndPassword: true,
          requireEmailVerification: config.auth.requireEmailVerification,
        },
        "Providers retrieved successfully"
      );
    }
  );

  /**
   * Ours, not Better Auth's — so it is documented in /docs, uses the house
   * envelope, and is the one place the frontend can ask "who am I" and get a
   * response shaped like every other endpoint here.
   */
  app.get(
    "/me",
    {
      onRequest: app.requireAuth,
      schema: {
        tags: ["auth"],
        summary: "The current user and session",
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        response: { 200: successEnvelope(meDtoSchema), 401: errorEnvelope },
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { session } = request;

      // Narrowing for the same reason requireUser exists: requireAuth sets both
      // or neither, but only the compiler needs convincing.
      if (!session) throw new Error("unreachable: requireAuth sets both");

      return ok(
        {
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
            image: user.image ?? null,
            role: user.role,
            createdAt: user.createdAt.toISOString(),
            updatedAt: user.updatedAt.toISOString(),
          },
          session: {
            id: session.id,
            expiresAt: session.expiresAt.toISOString(),
            createdAt: session.createdAt.toISOString(),
          },
        },
        "Session retrieved successfully"
      );
    }
  );
};

export default authRoutes;
