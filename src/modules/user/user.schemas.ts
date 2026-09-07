import { z } from "zod";
import { userRole } from "../auth/auth.schemas.ts";

/**
 * One schema per shape, and every route reuses these. A single Zod object is
 * simultaneously:
 *   1. the request validator,
 *   2. the response serializer (fields not listed here are DROPPED),
 *   3. the TypeScript type, via z.infer,
 *   4. the OpenAPI documentation.
 *
 * Note what is NOT here any more: there is no create-user body and no password
 * field of any kind. Accounts come into existence through Better Auth's
 * /api/auth/sign-up/email or through Google, and the password hash lives on the
 * accounts table. This module is now read-and-administer over the user table,
 * not a second way to make an account.
 *
 * There are two update bodies rather than one, because "what I may change about
 * myself" and "what an admin may change about anyone" are different sets and
 * collapsing them into a single schema is how `role` leaks into a self-service
 * route. See the note on each below.
 */

export { userRole };

const name = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(100, "Name cannot be more than 100 characters");

export const userIdParamSchema = z.object({
  id: z.uuid("User ID must be a valid UUID"),
});

/**
 * Email is deliberately absent from BOTH update bodies.
 *
 * Changing an address by UPDATE would walk straight past Better Auth's
 * verification step, and email is the key implicit account linking trusts — so
 * a silent email change is an account-takeover primitive. Email changes belong
 * to Better Auth's own change-email flow (`user.changeEmail`, off by default),
 * not to a generic PATCH.
 */

/**
 * What a user may change about THEMSELVES, via `PATCH /me`.
 *
 * `role` is deliberately absent, and that absence is a security control, not a
 * simplification. `auth.factory.ts` marks the field `input: false` so that a
 * sign-up body cannot grant admin; a self-service PATCH that accepted `role`
 * would hand back exactly the privilege escalation that flag exists to prevent.
 * Role changes live on the admin-only route below.
 *
 * `strictObject`, not `object`, and that matters here specifically. A plain Zod
 * object STRIPS unknown keys, so `{"name":"x","role":"admin"}` would be
 * accepted with a 200 and the role quietly ignored — safe, but it tells a
 * caller who just attempted an escalation that everything went fine. Strict
 * turns it into a 400 naming the offending field, which is both honest to a
 * client with a genuine typo and loud in a log when it is not one.
 */
export const updateSelfBodySchema = z
  .strictObject({
    name: name.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update",
  });

/**
 * What an admin may change about anyone, via `PATCH /:id`. This is the only
 * schema in the app that accepts `role`, and the only route that uses it is
 * behind `app.requireRole("admin")`. Strict for the same reason as above: a
 * misspelled field in an admin PATCH should not return 200 having done nothing.
 */
export const updateUserBodySchema = z
  .strictObject({
    name: name.optional(),
    role: userRole.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update",
  });

export const listUsersQuerySchema = z.object({
  // Query strings are always strings; coerce or every comparison downstream is
  // subtly wrong.
  page: z.coerce.number().int().min(1).default(1),
  // Capped so a caller cannot request the whole table in one query.
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
});

/** What the API returns. */
export const userDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  role: userRole,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type UserDto = z.infer<typeof userDtoSchema>;
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;
export type UpdateSelfBody = z.infer<typeof updateSelfBodySchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
