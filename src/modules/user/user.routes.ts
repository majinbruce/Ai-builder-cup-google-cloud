import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  errorEnvelope,
  ok,
  paginated,
  paginatedEnvelope,
  successEnvelope,
} from "../../lib/api-response.ts";
import { requireSelfOrAdmin, requireUser } from "../../lib/require-user.ts";
import * as userService from "./user.service.ts";
import {
  listUsersQuerySchema,
  updateSelfBodySchema,
  updateUserBodySchema,
  userDtoSchema,
  userIdParamSchema,
} from "./user.schemas.ts";

const userEnvelope = successEnvelope(userDtoSchema);
const commonErrors = {
  400: errorEnvelope,
  401: errorEnvelope,
  403: errorEnvelope,
  500: errorEnvelope,
};

/**
 * Everything in here is behind an authenticated session — carried by a cookie
 * for the browser, or a bearer token for everything else; requireAuth resolves
 * either transparently. The hook is declared ONCE, and
 * every route added to this scope inherits it — including routes added months
 * from now by someone who never reads this comment. That is the difference
 * from listing `authMiddleware` on each Express route: there, forgetting it is
 * a silent public endpoint; here, forgetting it is impossible.
 *
 * ==========================================================================
 * Authentication is not authorisation. The permission model, in full:
 * ==========================================================================
 *
 *   GET    /            admin        the whole table, every address in it
 *   GET    /:id         self|admin
 *   PATCH  /me          self         name only — never role
 *   PATCH  /:id         admin        name and role
 *   DELETE /:id         admin        cascades sessions and linked accounts
 *
 * The two rules worth stating out loud, because both are security controls
 * that look like product decisions:
 *
 *   1. `role` is writable ONLY through the admin route. `auth.factory.ts`
 *      marks the field `input: false` so a sign-up body cannot grant admin —
 *      a self-service PATCH that accepted `role` would give that back, and
 *      "authenticated user promotes themselves to admin" is the whole game.
 *      That is why `PATCH /me` exists as a separate route with a separate
 *      body schema instead of `PATCH /:id` checking who the caller is.
 *
 *   2. Listing is admin-only. `GET /` returns every user's email address, and
 *      "any verified account can enumerate the user table" is a data-export
 *      endpoint wearing an index route's clothes.
 *
 * Loosen these deliberately, per project — but loosen them here, where the
 * whole model is visible at once, rather than one route at a time.
 */
const securedUserRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("onRequest", app.requireAuth);

  app.get(
    "/",
    {
      // Every row carries an email address; see rule 2 above.
      preHandler: app.requireRole("admin"),
      schema: {
        tags: ["users"],
        summary: "List users (admin only)",
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        querystring: listUsersQuerySchema,
        response: { 200: paginatedEnvelope(userDtoSchema), ...commonErrors },
      },
    },
    async (request) => {
      const ctx = { db: app.db, log: request.log };
      const { data, ...meta } = await userService.listUsers(ctx, request.query);

      return paginated(data, meta, "Users retrieved successfully");
    }
  );

  app.get(
    "/:id",
    {
      schema: {
        tags: ["users"],
        summary: "Get a user by id (self or admin)",
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        params: userIdParamSchema,
        response: { 200: userEnvelope, 404: errorEnvelope, ...commonErrors },
      },
    },
    async (request) => {
      // Not a preHandler: the rule depends on a path param, so it is checked
      // here, after validation has proved the param is a UUID at all.
      requireSelfOrAdmin(request, request.params.id);

      const ctx = { db: app.db, log: request.log };
      const user = await userService.getUser(ctx, request.params.id);

      return ok(user, "User retrieved successfully");
    }
  );

  /**
   * Self-service. Static segments beat parametric ones in Fastify's router, so
   * this is matched before `/:id` no matter which is registered first — and
   * `/:id` would have rejected "me" as a non-UUID anyway.
   */
  app.patch(
    "/me",
    {
      schema: {
        tags: ["users"],
        summary: "Update your own profile",
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        body: updateSelfBodySchema,
        response: { 200: userEnvelope, 404: errorEnvelope, ...commonErrors },
      },
    },
    async (request) => {
      const actor = requireUser(request);
      const ctx = { db: app.db, log: request.log };

      // updateOwnProfile, not updateUser: the self-service path has no `role`
      // parameter to pass one to. See user.service.ts.
      //
      // The id comes from the resolved session, never from the request — so
      // there is no id here for a caller to swap for somebody else's.
      const user = await userService.updateOwnProfile(ctx, actor.id, request.body);

      return ok(user, "Profile updated successfully");
    }
  );

  app.patch(
    "/:id",
    {
      // Admin only, because this body is the one that accepts `role`; see
      // rule 1 above. Users edit themselves through PATCH /me.
      preHandler: app.requireRole("admin"),
      schema: {
        tags: ["users"],
        summary: "Update a user, including their role (admin only)",
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        params: userIdParamSchema,
        body: updateUserBodySchema,
        response: {
          200: userEnvelope,
          404: errorEnvelope,
          409: errorEnvelope,
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const ctx = { db: app.db, log: request.log };
      const user = await userService.updateUser(ctx, request.params.id, request.body);

      return ok(user, "User updated successfully");
    }
  );

  app.delete(
    "/:id",
    {
      // Authentication came from the scope's hook; authorisation is per-route,
      // and runs at preHandler — after validation, so an admin check never
      // burns CPU on a request that was malformed anyway.
      preHandler: app.requireRole("admin"),
      schema: {
        tags: ["users"],
        summary: "Delete a user and cascade their sessions (admin only)",
        security: [{ cookieAuth: [] }, { bearerAuth: [] }],
        params: userIdParamSchema,
        // 403 now lives in commonErrors — every route in this scope can
        // produce one.
        response: {
          200: successEnvelope(z.null()),
          404: errorEnvelope,
          ...commonErrors,
        },
      },
    },
    async (request) => {
      const ctx = { db: app.db, log: request.log };
      await userService.deleteUser(ctx, request.params.id);

      return ok(null, "User deleted successfully");
    }
  );
};

/**
 * There is no public POST here any more. An account comes into existence
 * through Better Auth — /api/auth/sign-up/email or the Google flow — so this
 * module is purely read-and-administer over the user table. A second creation
 * path would mean a user row with no matching `accounts` row: a user who
 * exists and can never sign in.
 */
const userRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(securedUserRoutes);
};

export default userRoutes;
