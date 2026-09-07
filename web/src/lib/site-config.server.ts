import "server-only";
import { cache } from "react";
import { env } from "@/lib/env";
import { successEnvelope } from "@/lib/api/envelope";
import { apiFetchServer } from "@/lib/api/server";
import { authProvidersSchema } from "@/lib/api/schemas";
import type { AuthCapabilities, SiteConfig } from "@/lib/site-config";

/**
 * ============================================================================
 * The sign-in screen is drawn from what the API says it supports.
 * ============================================================================
 *
 * Not from a flag in this app's environment. Only the API process knows whether
 * the Google provider is registered — Better Auth registers it if and only if
 * GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set — so a mirrored
 * `AUTH_GOOGLE_ENABLED` here is two settings that must agree, with a button
 * that 400s when they do not. `GET /api/auth/providers` is the API declaring
 * its own capabilities; this reads them.
 *
 * Failure is not fatal. If the API cannot be reached the sign-in page still
 * renders, with email and password only — the honest degradation, since a
 * social button we cannot confirm is a button we should not draw. The email
 * form will report the outage itself when it is submitted.
 */
const FALLBACK: AuthCapabilities = {
  social: [],
  emailAndPassword: true,
  requireEmailVerification: true,
};

/**
 * Memoised per render pass, so the layout and a page asking the same question
 * cost one request.
 *
 * NOT cached across requests, deliberately. It is tempting — the answer cannot
 * change while the API process is running — but the API can be redeployed with
 * new credentials underneath a long-lived frontend container, and a stale
 * process-level cache would hide a newly enabled provider until the next
 * restart. One extra request per render, on an endpoint that reads no database,
 * is the cheaper mistake.
 */
export const getAuthCapabilities = cache(async (): Promise<AuthCapabilities> => {
  try {
    const body = await apiFetchServer(
      "/api/auth/providers",
      successEnvelope(authProvidersSchema)
    );
    return body.data;
  } catch {
    return FALLBACK;
  }
});

/** Builds the client-visible config. Called once, by the root layout. */
export async function getSiteConfig(): Promise<SiteConfig> {
  return {
    appName: env.APP_NAME,
    auth: await getAuthCapabilities(),
  };
}
