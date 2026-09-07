import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers.ts";
import { createFakeMailer, type FakeMailer } from "../helpers/mailer.ts";
import { promoteToAdmin, registerAndSignIn } from "../helpers/auth.ts";
import type { App } from "../../src/app.ts";

/**
 * The permission model in src/modules/user/user.routes.ts, asserted route by
 * route. These need a real session, so they live here rather than in the unit
 * project.
 *
 * The first test is the important one: authenticating a user is not the same
 * as authorising them, and a PATCH that accepts `role` from a caller who is not
 * an admin hands back exactly the escalation that `input: false` on the field
 * exists to prevent.
 */
describe("user route authorisation", () => {
  let app: App;
  let mailer: FakeMailer;

  beforeAll(async () => {
    mailer = createFakeMailer();
    app = await buildTestApp(mailer);
  });

  afterAll(async () => {
    await app.close();
  });

  const roleOf = async (userId: string): Promise<string | undefined> => {
    const { rows } = await app.pg.query<{ role: string }>(
      "SELECT role FROM users WHERE id = $1",
      [userId]
    );
    return rows[0]?.role;
  };

  describe("PATCH /:id", () => {
    it("does not let an authenticated user promote themselves to admin", async () => {
      const actor = await registerAndSignIn(app, mailer);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/users/${actor.userId}`,
        headers: { cookie: actor.cookie },
        payload: { role: "admin" },
      });

      expect(res.statusCode).toBe(403);
      expect(await roleOf(actor.userId)).toBe("user");
    });

    it("does not let an authenticated user edit somebody else", async () => {
      const actor = await registerAndSignIn(app, mailer);
      const victim = await registerAndSignIn(app, mailer);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/users/${victim.userId}`,
        headers: { cookie: actor.cookie },
        payload: { name: "Renamed By A Stranger" },
      });

      expect(res.statusCode).toBe(403);
    });

    it("lets an admin change a role", async () => {
      const admin = await registerAndSignIn(app, mailer);
      await promoteToAdmin(app, admin.userId);
      const target = await registerAndSignIn(app, mailer);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/users/${target.userId}`,
        headers: { cookie: admin.cookie },
        payload: { role: "admin" },
      });

      expect(res.statusCode).toBe(200);
      expect(await roleOf(target.userId)).toBe("admin");
    });
  });

  describe("PATCH /me", () => {
    it("updates the caller's own name", async () => {
      const actor = await registerAndSignIn(app, mailer);

      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/users/me",
        headers: { cookie: actor.cookie },
        payload: { name: "New Name" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: { id: string; name: string } }>().data).toMatchObject({
        id: actor.userId,
        name: "New Name",
      });
    });

    /**
     * `role` is not in updateSelfBodySchema, so it is not "ignored" — the body
     * is rejected outright, which is the failure mode you want: a client that
     * thinks it can set a role finds out immediately.
     */
    it("rejects a role in the body rather than silently dropping it", async () => {
      const actor = await registerAndSignIn(app, mailer);

      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/users/me",
        headers: { cookie: actor.cookie },
        payload: { name: "Sneaky", role: "admin" },
      });

      expect(res.statusCode).toBe(400);
      expect(await roleOf(actor.userId)).toBe("user");
    });

    it("is routed before /:id, so 'me' is never parsed as a uuid", async () => {
      const actor = await registerAndSignIn(app, mailer);

      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/users/me",
        headers: { cookie: actor.cookie },
        payload: { name: "Still Me" },
      });

      // A fall-through to /:id would have been a 400 on the uuid param.
      expect(res.statusCode).toBe(200);
    });
  });

  describe("GET /:id", () => {
    it("lets a user read their own row", async () => {
      const actor = await registerAndSignIn(app, mailer);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/users/${actor.userId}`,
        headers: { cookie: actor.cookie },
      });

      expect(res.statusCode).toBe(200);
    });

    it("refuses a user reading somebody else's row", async () => {
      const actor = await registerAndSignIn(app, mailer);
      const other = await registerAndSignIn(app, mailer);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/users/${other.userId}`,
        headers: { cookie: actor.cookie },
      });

      expect(res.statusCode).toBe(403);
    });

    it("lets an admin read anybody's row", async () => {
      const admin = await registerAndSignIn(app, mailer);
      await promoteToAdmin(app, admin.userId);
      const other = await registerAndSignIn(app, mailer);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/users/${other.userId}`,
        headers: { cookie: admin.cookie },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe("GET /", () => {
    /** The list carries every user's email address. */
    it("refuses a non-admin", async () => {
      const actor = await registerAndSignIn(app, mailer);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/users",
        headers: { cookie: actor.cookie },
      });

      expect(res.statusCode).toBe(403);
    });

    it("lets an admin through", async () => {
      const admin = await registerAndSignIn(app, mailer);
      await promoteToAdmin(app, admin.userId);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/users",
        headers: { cookie: admin.cookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ meta: { total: number } }>().meta.total).toBeGreaterThan(0);
    });
  });
});
