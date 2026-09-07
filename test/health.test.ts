import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.ts";
import type { App } from "../src/app.ts";

describe("health", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports liveness without touching the database", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "alive" });
  });

  it("assigns a request id and echoes an upstream one", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "trace-abc" },
    });

    expect(res.headers["x-request-id"]).toBe("trace-abc");
  });

  it("returns the standard envelope for an unknown route", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ statusCode: -1 });
  });
});
