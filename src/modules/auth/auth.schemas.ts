import { z } from "zod";

/**
 * The role vocabulary, defined here because auth owns it — the factory's
 * `additionalFields.role` and the database CHECK constraint are the other two
 * places it appears, and all three must agree.
 */
export const userRole = z.enum(["user", "admin"]);

/**
 * What GET /api/auth/me returns.
 *
 * Everything Better Auth's own endpoints return is shaped by Better Auth (see
 * the note in auth.routes.ts). This route is ours, so it uses the house
 * envelope and the house serializer — which also means a field that is not
 * named here cannot leak, whatever the session object happens to carry.
 */
export const sessionUserDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  role: userRole,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const meDtoSchema = z.object({
  user: sessionUserDtoSchema,
  session: z.object({
    id: z.uuid(),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  }),
});

export type SessionUserDto = z.infer<typeof sessionUserDtoSchema>;

/**
 * What the sign-in screen needs to know before it can render itself.
 *
 * The frontend cannot guess this. Better Auth registers the Google provider
 * only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set, so a
 * "Continue with Google" button rendered against an API that has neither is a
 * button that 400s. The alternative — a matching flag in the frontend's own
 * environment — is two settings that must agree and silently do not.
 *
 * So the API declares its own capabilities and the UI follows. Same idea as
 * NextAuth's /providers endpoint, for the same reason.
 */
export const authProvidersDtoSchema = z.object({
  /** Provider ids usable with `signIn.social({ provider })`. */
  social: z.array(z.enum(["google"])),
  /** Whether /sign-up/email and /sign-in/email are enabled at all. */
  emailAndPassword: z.boolean(),
  /**
   * Whether an unverified account can sign in. Only changes which screen the
   * frontend shows after sign-up — the API enforces the rule either way.
   */
  requireEmailVerification: z.boolean(),
});

export type AuthProvidersDto = z.infer<typeof authProvidersDtoSchema>;
