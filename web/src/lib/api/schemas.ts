import { z } from "zod";

/**
 * ============================================================================
 * The API's DTOs, restated on this side of the wire.
 * ============================================================================
 *
 * These mirror the API's per-module `*.schemas.ts` files in the API. The duplication is
 * deliberate and is the price of two independently deployed services: the
 * frontend and the API version separately, and a running frontend must be able
 * to say "that response is not the shape I was built against" rather than
 * render `undefined`.
 *
 * KEEP THEM IN SYNC. When a DTO changes in the API, change it here in the same
 * commit. `npm run typecheck` will not catch the drift — the parse at runtime
 * will, which is why every response goes through one.
 */
export const userRoleSchema = z.enum(["user", "admin"]);
export type UserRole = z.infer<typeof userRoleSchema>;

/** Mirrors `userDtoSchema` / `sessionUserDtoSchema` in the API. */
export const userSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  role: userRoleSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type User = z.infer<typeof userSchema>;

/** Mirrors `meDtoSchema` — the payload of `GET /api/auth/me`. */
export const meSchema = z.object({
  user: userSchema,
  session: z.object({
    id: z.uuid(),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  }),
});
export type Me = z.infer<typeof meSchema>;

/** Mirrors `authProvidersDtoSchema` — the payload of `GET /api/auth/providers`. */
export const authProvidersSchema = z.object({
  social: z.array(z.enum(["google"])),
  emailAndPassword: z.boolean(),
  requireEmailVerification: z.boolean(),
});
export type AuthProviders = z.infer<typeof authProvidersSchema>;
