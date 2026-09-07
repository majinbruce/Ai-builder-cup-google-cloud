import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.ts";
import type { App } from "../src/app.ts";

/**
 * None of these reach Postgres: validation and auth both reject the request
 * before the handler runs. That is the point of doing them as lifecycle hooks
 * rather than as code inside the handler.
 */
describe("user routes", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects an unauthenticated list request", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/users" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ statusCode: -1 });
  });

  /**
   * The cases that need an authenticated caller (path validation behind the
   * guard, and role gating) moved to test/integration/, because a session is
   * now a row in Postgres rather than a signature this process can mint.
   */

  it("rejects a malformed JSON body with 400, not 500", async () => {
    // Aimed at the auth handler now: it installs its own content-type parser
    // (to tolerate empty bodies), so this asserts that loosening it did not
    // also start accepting garbage.
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: "{ not json",
    });

    expect(res.statusCode).toBe(400);
  });
});
