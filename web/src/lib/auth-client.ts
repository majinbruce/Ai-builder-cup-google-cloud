"use client";

import { createAuthClient } from "better-auth/react";
import { inferAdditionalFields } from "better-auth/client/plugins";

/**
 * ============================================================================
 * The Better Auth browser client — the mirror image of the API's auth factory.
 * ============================================================================
 *
 * Everything the UI does with authentication goes through this object:
 * `signIn.email`, `signUp.email`, `signOut`, `forgetPassword`, `resetPassword`,
 * `sendVerificationEmail`, `useSession`. There is no hand-rolled fetch to
 * `/api/auth/*` anywhere in this app, and there should not be — the SDK owns
 * that wire format, including the `{ code, message }` error shape the API's
 * catch-all route deliberately passes through untouched.
 *
 * No `baseURL`. Omitting it resolves to the current origin, which is exactly
 * right here: `/api/auth/*` is same-origin in every environment (see
 * next.config.ts). Hardcoding an origin is what breaks the moment the app is
 * served from a preview domain.
 */
export const authClient = createAuthClient({
  // The API mounts Better Auth at this prefix; it is `config.auth.basePath`
  // there and is hardcoded on both sides on purpose.
  basePath: "/api/auth",

  plugins: [
    /**
     * Teaches the client that `session.user` carries a `role`.
     *
     * The API declares it in `user.additionalFields` (auth.factory.ts). Without
     * this the field still ARRIVES over the wire — it is just untyped, so
     * `user.role` is a type error and the compiler cannot check a role
     * comparison. Adding a field there means adding it here.
     *
     * The types are declared inline rather than imported from the API package,
     * because the two are separate deployables with separate installs. If you
     * ever merge them into one workspace, `inferAdditionalFields<typeof auth>()`
     * derives this from the server instance and removes the duplication.
     */
    inferAdditionalFields({
      user: {
        role: { type: "string", input: false },
      },
    }),
  ],
});

/**
 * A convenience re-export, so components import `useSession` rather than
 * reaching through `authClient` — the type is identical either way.
 *
 * `useSession()` is a live subscription: it revalidates after sign-in,
 * sign-out and window focus, and every component using it re-renders together.
 * It is an OPTIMISTIC view of the session, good enough to decide what to
 * render. It is not an authorisation check. The API re-resolves the session
 * from the database on every request it serves; that is the check.
 */
export const { useSession, signIn, signUp, signOut } = authClient;

/** The session shape as this client sees it, `role` included. */
export type Session = typeof authClient.$Infer.Session;
export type SessionUser = Session["user"];
export type UserRole = "user" | "admin";
