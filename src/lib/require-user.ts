import type { FastifyRequest } from "fastify";
import type { AuthUser } from "../plugins/auth.ts";
import { forbidden, unauthorized } from "./errors.ts";

/**
 * Narrows `request.user` from `AuthUser | null` to `AuthUser`.
 *
 * `request.user` has to be nullable, because it genuinely is null on every
 * unauthenticated request and two places read it that way (the error handler's
 * log line and the rate limiter's key). But inside a handler that sits behind
 * `app.requireAuth`, it is never null — and expressing that with a `!` would be
 * asserting something the compiler cannot check, which is exactly the kind of
 * lie that survives a later refactor moving the route out of the guarded scope.
 *
 * So the check is real. If the hook is ever removed, this throws a 401 instead
 * of dereferencing null — the same shape as the `if (!row) throw notFound()`
 * pattern the repositories already use.
 */
export const requireUser = (request: FastifyRequest): AuthUser => {
  if (!request.user) throw unauthorized("Authentication required");
  return request.user;
};

/**
 * The "self or admin" rule, for routes where the resource IS a user.
 *
 * This cannot be a `requireRole()`-style preHandler: the decision depends on a
 * path parameter, so it belongs inside the handler where the target id is
 * known and already validated. Everything else about it matches requireRole —
 * it throws the same 403 through the same envelope.
 *
 * Ordering matters. An admin is allowed through before the ownership check, so
 * an admin acting on someone else's row is not a special case at the call site.
 */
export const requireSelfOrAdmin = (
  request: FastifyRequest,
  targetUserId: string
): AuthUser => {
  const user = requireUser(request);

  if (user.role !== "admin" && user.id !== targetUserId) {
    throw forbidden("You do not have permission to access this user");
  }

  return user;
};
