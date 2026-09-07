import fp from "fastify-plugin";
import { fromNodeHeaders } from "better-auth/node";
import type { onRequestHookHandler, preHandlerHookHandler } from "fastify";
import { createAuth, type Auth } from "../modules/auth/auth.factory.ts";
import { createMailer, type Mailer } from "../lib/mailer.ts";
import { requireUser } from "../lib/require-user.ts";
import { forbidden, unauthorized } from "../lib/errors.ts";

/**
 * The shapes Better Auth resolves a request into. Both are DERIVED from the
 * configuration in auth.factory.ts rather than written out here, so adding an
 * `additionalFields` entry there updates `request.user` with no second edit —
 * `role` arrives through exactly this path.
 */
export type AuthUser = Auth["$Infer"]["Session"]["user"];
export type AuthSession = Auth["$Infer"]["Session"]["session"];

declare module "fastify" {
  interface FastifyInstance {
    /** The Better Auth instance. Routes reach the server-side API through it. */
    auth: Auth;
    /** onRequest hook: resolves a session from a cookie OR a bearer token. */
    requireAuth: onRequestHookHandler;
    /** preHandler factory: run *after* requireAuth, gates on role. */
    requireRole: (...roles: AuthUser["role"][]) => preHandlerHookHandler;
  }

  interface FastifyRequest {
    /**
     * Null until `requireAuth` runs, and on every route that does not use it.
     * Use `requireUser(request)` inside a guarded handler to narrow it.
     */
    user: AuthUser | null;
    session: AuthSession | null;
  }
}

export interface AuthPluginOptions {
  /**
   * Overrides the console mailer. The tests pass a fake so they can read the
   * verification and reset tokens straight out of the message instead of
   * running a mail server — which is the entire reason Mailer is an interface.
   */
  mailer?: Mailer;
}

export default fp<AuthPluginOptions>(
  async (app, opts) => {
    /**
     * The live instance. Note what it is given: the application's own Drizzle
     * instance, so Better Auth shares the connections, the slow-query logging,
     * the error handling and the shutdown path that plugins/db.ts already owns
     * — and runs its queries against the same table definitions the
     * repositories do.
     *
     * The mailer is chosen by configuration, not by code: MAIL_PROVIDER picks
     * between the console implementation (the default, which logs the link so
     * a fresh clone works with no account anywhere) and Resend. `opts.mailer`
     * overrides both, which is how the tests inject a fake.
     */
    const auth = createAuth({
      db: app.db,
      mailer: opts.mailer ?? createMailer(app.log),
      log: app.log,
    });

    app.decorate("auth", auth);

    /**
     * Fastify needs to know these properties exist before the first request, so
     * the request object keeps a stable shape (a hidden-class optimisation, but
     * also the reason `request.user` is defined rather than missing on routes
     * that never authenticate).
     */
    app.decorateRequest("user", null);
    app.decorateRequest("session", null);

    /**
     * ======================================================================
     * Where the cookie path and the bearer path converge — and it is one call.
     * ======================================================================
     *
     * `getSession` is handed the request's headers and works out the rest. It
     * looks for the session cookie; the `bearer()` plugin registered in the
     * factory additionally teaches it to look at `Authorization: Bearer`. Both
     * carry the same opaque token, and both resolve to the SAME row in the
     * `sessions` table.
     *
     * So there is no branch here on client type, no second token format and no
     * parallel user model. A mobile client differs from the browser only in
     * where it stores the string it was given at sign-in.
     *
     * The lookup hits Postgres on every request. That is the deliberate cost of
     * sessions being revocable — see the cookieCache note in auth.factory.ts.
     */
    app.decorate("requireAuth", async function requireAuth(request) {
      const resolved = await auth.api.getSession({
        // Fastify's headers are Node's IncomingHttpHeaders; Better Auth speaks
        // the WHATWG Headers type. This is the adapter between them.
        headers: fromNodeHeaders(request.headers),
      });

      if (!resolved) {
        // AppError, so the standard error envelope and the standard log line
        // apply — an unauthenticated request looks like every other 401.
        throw unauthorized("Authentication required");
      }

      request.user = resolved.user;
      request.session = resolved.session;
    });

    /**
     * Unchanged in shape from the JWT version it replaces, so route files that
     * used it keep working: authentication is a scope-wide onRequest hook,
     * authorisation is a per-route preHandler that runs after validation.
     */
    app.decorate(
      "requireRole",
      (...roles: AuthUser["role"][]): preHandlerHookHandler =>
        async function requireRole(request) {
          const user = requireUser(request);

          if (!roles.includes(user.role)) {
            throw forbidden("You do not have permission to perform this action");
          }
        }
    );
  },
  {
    name: "auth",
    // Better Auth is handed app.db, so the Drizzle instance must exist first.
    dependencies: ["db"],
  }
);
