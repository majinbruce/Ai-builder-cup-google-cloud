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
 * The policies in modules/auth/auth.policies.ts are unit-tested next door. What
 * these assert is the wiring: that Better Auth actually consults them, on every
 * path that writes the value, including the endpoints its router owns and our
 * route file never mentions.
 *
 * That distinction matters. `POST /api/auth/update-user` is not declared
 * anywhere in this codebase — it arrives through the catch-all in
 * auth.routes.ts — so a check that only guarded our own handlers would miss it
 * entirely, which is exactly what it did before.
 */
describe("password policy", () => {
  let app: App;
  let mailer: FakeMailer;

  beforeAll(async () => {
    mailer = createFakeMailer();
    app = await buildTestApp(mailer);
  });

  afterAll(async () => {
    await app.close();
  });

  it("refuses a weak password at sign-up", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { origin: TRUSTED_ORIGIN },
      payload: { email: uniqueEmail(), password: "Password123", name: "Weak" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe("WEAK_PASSWORD");
  });

  it("does not create the user when the password is refused", async () => {
    const email = uniqueEmail();

    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { origin: TRUSTED_ORIGIN },
      payload: { email, password: "password", name: "Weak" },
    });

    const { rows } = await app.pg.query("SELECT id FROM users WHERE email = $1", [email]);

    expect(rows).toHaveLength(0);
  });

  it("refuses a weak password when changing it", async () => {
    const identity = await registerAndSignIn(app, mailer);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { origin: TRUSTED_ORIGIN, cookie: identity.cookie },
      payload: { currentPassword: identity.password, newPassword: "qwertyuiop" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe("WEAK_PASSWORD");
  });

  it("allows a strong password through the same path", async () => {
    const identity = await registerAndSignIn(app, mailer);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { origin: TRUSTED_ORIGIN, cookie: identity.cookie },
      payload: { currentPassword: identity.password, newPassword: STRONG_NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
  });

  /**
   * The rule deliberately does not apply to sign-in. Anyone who registered
   * before the policy existed still has to be able to get in and change their
   * password — enforcing strength at the door would lock them out instead.
   */
  it("does not apply the policy to sign-in", async () => {
    const identity = await registerAndSignIn(app, mailer);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: TRUSTED_ORIGIN },
      payload: { email: identity.email, password: STRONG_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe("profile image policy", () => {
  let app: App;
  let mailer: FakeMailer;

  beforeAll(async () => {
    mailer = createFakeMailer();
    app = await buildTestApp(mailer);
  });

  afterAll(async () => {
    await app.close();
  });

  const updateImage = async (cookie: string, image: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/auth/update-user",
      headers: { origin: TRUSTED_ORIGIN, cookie },
      payload: { image },
    });

  it("refuses a javascript: URL through Better Auth's own update-user", async () => {
    const identity = await registerAndSignIn(app, mailer);
    const response = await updateImage(identity.cookie, "javascript:alert(1)");

    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe("INVALID_IMAGE_URL");
  });

  it("does not persist the refused value", async () => {
    const identity = await registerAndSignIn(app, mailer);

    await updateImage(identity.cookie, "javascript:alert(1)");

    const { rows } = await app.pg.query<{ image: string | null }>(
      "SELECT image FROM users WHERE id = $1",
      [identity.userId]
    );

    expect(rows[0]?.image).toBeNull();
  });

  it("accepts an https URL and stores it", async () => {
    const identity = await registerAndSignIn(app, mailer);
    const url = "https://cdn.example.com/avatars/me.png";

    const response = await updateImage(identity.cookie, url);

    expect(response.statusCode).toBe(200);

    const { rows } = await app.pg.query<{ image: string | null }>(
      "SELECT image FROM users WHERE id = $1",
      [identity.userId]
    );

    expect(rows[0]?.image).toBe(url);
  });

  /**
   * An update that does not mention `image` must not be treated as one that
   * clears it — the database hook sees a partial object, and "absent" and
   * "null" are different intentions.
   */
  it("leaves the image alone on an unrelated update", async () => {
    const identity = await registerAndSignIn(app, mailer);
    const url = "https://cdn.example.com/avatars/keep.png";

    await updateImage(identity.cookie, url);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/update-user",
      headers: { origin: TRUSTED_ORIGIN, cookie: identity.cookie },
      payload: { name: "Renamed" },
    });

    expect(response.statusCode).toBe(200);

    const { rows } = await app.pg.query<{ image: string | null; name: string }>(
      "SELECT image, name FROM users WHERE id = $1",
      [identity.userId]
    );

    expect(rows[0]?.name).toBe("Renamed");
    expect(rows[0]?.image).toBe(url);
  });

  it("lets a user clear their avatar", async () => {
    const identity = await registerAndSignIn(app, mailer);

    await updateImage(identity.cookie, "https://cdn.example.com/avatars/x.png");

    const response = await updateImage(identity.cookie, null);

    expect(response.statusCode).toBe(200);
  });
});

describe("upstream x-request-id", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const requestIdFor = async (header: string) => {
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": header },
    });

    return response.headers["x-request-id"];
  };

  it("honours a well-formed upstream id, so a trace survives the hop", async () => {
    const id = "0af7651916cd43dd8448eb211c80319c";

    expect(await requestIdFor(id)).toBe(id);
  });

  it("discards an over-long id rather than stamping it on every log line", async () => {
    const id = "a".repeat(129);
    const assigned = await requestIdFor(id);

    expect(assigned).not.toBe(id);
    expect(assigned).toHaveLength(36); // a fresh UUID
  });

  it("discards an id carrying newlines or markup", async () => {
    expect(await requestIdFor("abc\ninjected=1")).toHaveLength(36);
    expect(await requestIdFor("<script>alert(1)</script>")).toHaveLength(36);
    expect(await requestIdFor(" ")).toHaveLength(36);
  });
});

describe("self-service profile update", () => {
  let app: App;
  let mailer: FakeMailer;

  beforeAll(async () => {
    mailer = createFakeMailer();
    app = await buildTestApp(mailer);
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * The route rejects `role` via its schema, which is asserted in
   * user-permissions.test.ts. This asserts the layer behind it: even a body
   * that got past the schema has nowhere to put a role, because
   * updateOwnProfile has no such parameter.
   */
  it("updates the name and leaves the role untouched", async () => {
    const identity = await registerAndSignIn(app, mailer);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me",
      headers: { origin: TRUSTED_ORIGIN, cookie: identity.cookie },
      payload: { name: "Renamed Self" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { name: string; role: string } }>().data).toMatchObject({
      name: "Renamed Self",
      role: "user",
    });
  });
});
