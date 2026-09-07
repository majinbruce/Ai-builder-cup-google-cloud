import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers.ts";
import { createFakeMailer, type FakeMailer } from "../helpers/mailer.ts";
import { promoteToAdmin, registerAndSignIn } from "../helpers/auth.ts";
import type { App } from "../../src/app.ts";

describe("requireAuth", () => {
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
   * The claim the whole "cookie and bearer are not two auth systems" design
   * rests on. If this ever fails, the mobile story has quietly become a second
   * session model.
   */
  it("resolves the SAME session from a cookie and from a bearer token", async () => {
    const { cookie, bearer } = await registerAndSignIn(app, mailer);

    const viaCookie = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });

    const viaBearer = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${bearer}` },
    });

    expect(viaCookie.statusCode).toBe(200);
    expect(viaBearer.statusCode).toBe(200);

    const cookieSession = viaCookie.json<{ data: { session: { id: string } } }>();
    const bearerSession = viaBearer.json<{ data: { session: { id: string } } }>();

    expect(bearerSession.data.session.id).toBe(cookieSession.data.session.id);
  });

  it("rejects an unauthenticated request in the standard envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/users" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ statusCode: -1 });
  });

  it("rejects a garbage bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: "Bearer not-a-real-token" },
    });

    expect(res.statusCode).toBe(401);
  });

  /**
   * The test that justifies leaving session.cookieCache off. With a cache
   * enabled this would keep returning 200 until the cached cookie expired.
   */
  it("stops accepting a session the moment its row is deleted", async () => {
    const { cookie } = await registerAndSignIn(app, mailer);

    const before = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);

    const sessionId = before.json<{ data: { session: { id: string } } }>().data.session
      .id;
    await app.pg.query("DELETE FROM sessions WHERE id = $1", [sessionId]);

    const after = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  /** Deleting the user cascades to sessions, so it revokes every login too. */
  it("revokes every session when the user row is deleted", async () => {
    const { cookie, userId } = await registerAndSignIn(app, mailer);

    await app.pg.query("DELETE FROM users WHERE id = $1", [userId]);

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("requireRole", () => {
  let app: App;
  let mailer: FakeMailer;

  beforeAll(async () => {
    mailer = createFakeMailer();
    app = await buildTestApp(mailer);
  });

  afterAll(async () => {
    await app.close();
  });

  it("blocks a non-admin from deleting, after authenticating them", async () => {
    const actor = await registerAndSignIn(app, mailer);
    const victim = await registerAndSignIn(app, mailer);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/${victim.userId}`,
      headers: { cookie: actor.cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  it("lets an admin through, over either transport", async () => {
    const admin = await registerAndSignIn(app, mailer);
    await promoteToAdmin(app, admin.userId);

    const victim = await registerAndSignIn(app, mailer);
    const otherVictim = await registerAndSignIn(app, mailer);

    const viaCookie = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/${victim.userId}`,
      headers: { cookie: admin.cookie },
    });
    expect(viaCookie.statusCode).toBe(200);

    const viaBearer = await app.inject({
      method: "DELETE",
      url: `/api/v1/users/${otherVictim.userId}`,
      headers: { authorization: `Bearer ${admin.bearer}` },
    });
    expect(viaBearer.statusCode).toBe(200);
  });

  it("validates the path before the role check, for an authenticated caller", async () => {
    const admin = await registerAndSignIn(app, mailer);
    await promoteToAdmin(app, admin.userId);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/users/not-a-uuid",
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(400);
  });
});
