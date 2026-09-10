import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.ts";
import type { App } from "../src/app.ts";
import { jobKey, parseRangeHeader, parseStorageUri } from "../src/lib/storage.ts";

/**
 * The localize routes up to the point they would touch Postgres, plus the two
 * pure helpers the audio route stands on. Everything with a session, a job row
 * or a real upload is in test/integration/localize.test.ts.
 */
describe("localize routes without a session", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const id = "00000000-0000-4000-8000-000000000000";

  it.each([
    ["POST", "/api/v1/localize/jobs"],
    ["GET", "/api/v1/localize/jobs"],
    ["GET", `/api/v1/localize/jobs/${id}`],
    ["GET", `/api/v1/localize/jobs/${id}/audio/output`],
  ] as const)("%s %s is 401 before anything else runs", async (method, url) => {
    const res = await app.inject({ method, url });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ statusCode: -1 });
  });

  it("validates the public demo audio param before reading the database", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/localize/demo/audio/secrets",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ statusCode: -1, message: "Validation failed" });
  });
});

describe("parseRangeHeader", () => {
  const size = 1000;

  it("means 'whole file' when there is no header", () => {
    expect(parseRangeHeader(undefined, size)).toBeUndefined();
    expect(parseRangeHeader("", size)).toBeUndefined();
  });

  it("parses the forms an <audio> element sends", () => {
    expect(parseRangeHeader("bytes=0-", size)).toEqual({ start: 0, end: 999 });
    expect(parseRangeHeader("bytes=0-1023", size)).toEqual({ start: 0, end: 999 });
    expect(parseRangeHeader("bytes=100-199", size)).toEqual({ start: 100, end: 199 });
    expect(parseRangeHeader("bytes=-100", size)).toEqual({ start: 900, end: 999 });
  });

  it("refuses what it cannot satisfy rather than guessing", () => {
    expect(parseRangeHeader("bytes=1000-", size)).toBeNull();
    expect(parseRangeHeader("bytes=5-2", size)).toBeNull();
    expect(parseRangeHeader("bytes=-", size)).toBeNull();
    expect(parseRangeHeader("bytes=-0", size)).toBeNull();
    expect(parseRangeHeader("bytes=0-1,5-9", size)).toBeNull();
    expect(parseRangeHeader("items=0-1", size)).toBeNull();
    expect(parseRangeHeader("bytes=0-", 0)).toBeNull();
  });
});

describe("parseStorageUri", () => {
  it("splits a GCS URI into bucket and key", () => {
    expect(parseStorageUri("gs://my-bucket/jobs/abc/source.mp3")).toEqual({
      backend: "gcs",
      bucket: "my-bucket",
      key: "jobs/abc/source.mp3",
    });
  });

  it("accepts a local path only inside the storage root", () => {
    const inside = path.resolve("outputs", "storage", jobKey("abc", "output.mp3"));

    expect(parseStorageUri(inside)).toEqual({ backend: "local", filePath: inside });
  });

  it("refuses a stored URI that points anywhere else", () => {
    expect(() => parseStorageUri("/etc/passwd")).toThrow(/Refusing/);
    expect(() =>
      parseStorageUri(path.resolve("outputs", "storage", "..", "..", "package.json"))
    ).toThrow(/Refusing/);
    expect(() => parseStorageUri("gs://bucket-only")).toThrow(/Malformed/);
  });
});
