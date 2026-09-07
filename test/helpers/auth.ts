import { randomUUID } from "node:crypto";
import type { App } from "../../src/app.ts";
import type { FakeMailer } from "./mailer.ts";

/**
 * Better Auth refuses a state-changing request that arrives with cookies but no
 * Origin header — that is its CSRF defence, and it is doing its job. A browser
 * always sends one; app.inject does not unless told. So every helper here sends
 * the trusted origin, and there is a test asserting an untrusted one is refused.
 */
export const TRUSTED_ORIGIN = "http://localhost:3002";

export interface TestIdentity {
  email: string;
  password: string;
  name: string;
  userId: string;
  /** Cookie header value for the browser path. */
  cookie: string;
  /** The same session, as a bearer token, for the non-browser path. */
  bearer: string;
}

/** A fresh address per call. This is what keeps parallel test files isolated. */
export const uniqueEmail = () => `test-${randomUUID()}@example.com`;

/**
 * The password every helper uses, as a constant rather than a literal repeated
 * across files.
 *
 * It has to satisfy checkPasswordPolicy (see modules/auth/auth.policies.ts),
 * which is why it is not the obvious "Password123" — that one is refused,
 * correctly, because stripping its trailing digits leaves a denylisted word.
 * If you tighten the policy and the whole suite goes red on sign-up, this is
 * the line to change.
 */
export const STRONG_PASSWORD = "Correct-Horse-Battery-7";

/** A second acceptable password, for tests that change or reset the first. */
export const STRONG_NEW_PASSWORD = "Vermilion-Kettle-Parade-4";

const collectCookies = (raw: string | string[] | undefined): string =>
  (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

/**
 * The full real-user journey: sign up, read the verification link out of the
 * fake mailer, follow it, then sign in. AUTH_REQUIRE_EMAIL_VERIFICATION is on
 * in .env.test precisely so the tests walk the same path production does.
 */
export const registerAndSignIn = async (
  app: App,
  mailer: FakeMailer,
  overrides: { email?: string; password?: string; name?: string } = {}
): Promise<TestIdentity> => {
  const email = overrides.email ?? uniqueEmail();
  const password = overrides.password ?? STRONG_PASSWORD;
  const name = overrides.name ?? "Test User";

  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: TRUSTED_ORIGIN },
    payload: { email, password, name },
  });

  if (signUp.statusCode !== 200) {
    throw new Error(`sign-up failed: ${signUp.statusCode} ${signUp.body}`);
  }

  const userId = signUp.json<{ user: { id: string } }>().user.id;

  // The link points at BETTER_AUTH_URL; inject wants a path.
  const verifyUrl = new URL(mailer.lastLink(email));
  const verify = await app.inject({
    method: "GET",
    url: `${verifyUrl.pathname}${verifyUrl.search}`,
    headers: { origin: TRUSTED_ORIGIN },
  });

  if (verify.statusCode >= 400) {
    throw new Error(`verification failed: ${verify.statusCode} ${verify.body}`);
  }

  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: TRUSTED_ORIGIN },
    payload: { email, password },
  });

  if (signIn.statusCode !== 200) {
    throw new Error(`sign-in failed: ${signIn.statusCode} ${signIn.body}`);
  }

  const bearer = signIn.headers["set-auth-token"];

  if (typeof bearer !== "string") {
    throw new Error("bearer() plugin did not return a set-auth-token header");
  }

  return {
    email,
    password,
    name,
    userId,
    cookie: collectCookies(signIn.headers["set-cookie"]),
    bearer,
  };
};

/**
 * Role is `input: false`, so it can never be set through the API — which is the
 * point. Promoting a test user is therefore a direct UPDATE, and the next
 * getSession picks it up because the session join re-reads the user row.
 */
export const promoteToAdmin = async (app: App, userId: string): Promise<void> => {
  await app.pg.query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);
};
