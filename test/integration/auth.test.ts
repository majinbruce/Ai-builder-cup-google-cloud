import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers.ts";
import { createFakeMailer, type FakeMailer } from "../helpers/mailer.ts";
import {
  registerAndSignIn,
  STRONG_NEW_PASSWORD,
  STRONG_PASSWORD,
  TRUSTED_ORIGIN,
  uniqueEmail,
} from "../helpers/auth.ts";
import type { App } from "../../src/app.ts";

/**
 * These run against a real Postgres (see test/globalSetup.ts). Everything below
 * is a claim about behaviour that only the real database can settle.
 */
describe("email + password", () => {
  let app: App;
  let mailer: FakeMailer;

  beforeAll(async () => {
    mailer = createFakeMailer();
    app = await buildTestApp(mailer);
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates a user row and a credential account holding the hash", async () => {
    const { userId, email } = await registerAndSignIn(app, mailer);

    const { rows } = await app.pg.query<{
      email: string;
      role: string;
      provider_id: string;
      has_password: boolean;
    }>(
      `SELECT u.email, u.role, a.provider_id, (a.password IS NOT NULL) AS has_password
       FROM users u JOIN accounts a ON a.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );

    // The password lives on the account, not the user — that separation is what
    // lets the same person also have a Google account later.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email,
      role: "user",
      provider_id: "credential",
      has_password: true,
    });
  });

  it("refuses sign-in until the address is verified", async () => {
    const email = uniqueEmail();

    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { origin: TRUSTED_ORIGIN },
      payload: { email, password: STRONG_PASSWORD, name: "Unverified" },
    });

    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: TRUSTED_ORIGIN },
      payload: { email, password: STRONG_PASSWORD },
    });

    expect(signIn.statusCode).toBe(403);
    expect(signIn.json<{ code: string }>().code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("sends a verification link that verifies the address when followed", async () => {
    const email = uniqueEmail();

    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { origin: TRUSTED_ORIGIN },
      payload: { email, password: STRONG_PASSWORD, name: "Verify Me" },
    });

    const link = new URL(mailer.lastLink(email));
    expect(link.pathname).toBe("/api/auth/verify-email");

    await app.inject({
      method: "GET",
      url: `${link.pathname}${link.search}`,
      headers: { origin: TRUSTED_ORIGIN },
    });

    const { rows } = await app.pg.query<{ email_verified: boolean }>(
      "SELECT email_verified FROM users WHERE email = $1",
      [email]
    );

    expect(rows[0]?.email_verified).toBe(true);
  });

  it("cannot be tricked into granting admin through the sign-up body", async () => {
    const email = uniqueEmail();

    // `role` is declared with input: false. If that ever regresses, this is a
    // self-service privilege escalation, so it gets its own test.
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { origin: TRUSTED_ORIGIN },
      payload: { email, password: STRONG_PASSWORD, name: "Sneaky", role: "admin" },
    });

    const { rows } = await app.pg.query<{ role: string }>(
      "SELECT role FROM users WHERE email = $1",
      [email]
    );

    expect(rows[0]?.role).toBe("user");
  });

  it("resets a password end to end and revokes the old sessions", async () => {
    const identity = await registerAndSignIn(app, mailer);

    const requested = await app.inject({
      method: "POST",
      url: "/api/auth/request-password-reset",
      headers: { origin: TRUSTED_ORIGIN },
      payload: { email: identity.email, redirectTo: `${TRUSTED_ORIGIN}/reset` },
    });
    expect(requested.statusCode).toBe(200);

    // The reset link 302s to redirectTo carrying the token; follow it to get it.
    const link = new URL(mailer.lastLink(identity.email));
    const redirect = await app.inject({
      method: "GET",
      url: `${link.pathname}${link.search}`,
      headers: { origin: TRUSTED_ORIGIN },
    });

    const token = new URL(
      redirect.headers["location"] as string,
      TRUSTED_ORIGIN
    ).searchParams.get("token");
    expect(token).toBeTruthy();

    const reset = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      headers: { origin: TRUSTED_ORIGIN },
      payload: { newPassword: STRONG_NEW_PASSWORD, token },
    });
    expect(reset.statusCode).toBe(200);

    // The new password works...
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: TRUSTED_ORIGIN },
      payload: { email: identity.email, password: STRONG_NEW_PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);

    // ...and revokeSessionsOnPasswordReset killed the session held before it.
    const oldSession = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: identity.cookie },
    });
    expect(oldSession.statusCode).toBe(401);
  });

  it("rejects a state-changing request from an untrusted origin", async () => {
    const identity = await registerAndSignIn(app, mailer);

    // Better Auth's CSRF defence: cookies present, Origin not in trustedOrigins.
    const forged = await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      headers: { origin: "http://evil.example", cookie: identity.cookie },
    });

    expect(forged.statusCode).toBe(403);
  });
});

describe("google oauth", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildTestApp(createFakeMailer());
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Google itself is never contacted. What is worth asserting is the half we
   * own: that the provider is registered, that we redirect to Google with CSRF
   * state and PKCE, and that the state was persisted so the callback can verify
   * it later. Mocking Google's token endpoint would only test Better Auth.
   */
  it("redirects to Google with state and PKCE, and persists the state", async () => {
    const before = await app.pg.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM verifications"
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/social",
      headers: { origin: TRUSTED_ORIGIN },
      payload: { provider: "google", callbackURL: `${TRUSTED_ORIGIN}/welcome` },
    });

    expect(res.statusCode).toBe(200);

    const url = new URL(res.json<{ url: string }>().url);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("test-google-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3001/api/auth/callback/google"
    );
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const after = await app.pg.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM verifications"
    );
    expect(Number(after.rows[0]?.count)).toBeGreaterThan(Number(before.rows[0]?.count));
  });

  it("refuses a callbackURL that is not a trusted origin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/social",
      headers: { origin: TRUSTED_ORIGIN },
      payload: { provider: "google", callbackURL: "http://evil.example/steal" },
    });

    // Otherwise the auth endpoints are an open redirect.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
