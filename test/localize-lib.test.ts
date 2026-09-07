import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegAvailable } from "../src/lib/ffmpeg.ts";
import { audioPart } from "../src/lib/gemini.ts";
import { loadPrompt } from "../src/lib/prompts.ts";

/**
 * The pure logic under src/lib that the Phase 0 smoke test deliberately does
 * not cover.
 *
 * smoke-gemini.ts proves the network path and cannot be a unit test — it exists
 * because the assumption it checks cannot be mocked. That leaves the file
 * handling around it, which is all hand-written error messages and boundary
 * conditions, with no regression net at all. These are the cases a stage script
 * hits at 2am, so they are worth pinning: a wrong path, a wrong extension, a
 * file one byte too big, a prompt name with a typo.
 *
 * Nothing here calls Gemini or needs a key.
 */

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "localize-lib-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const writeFixture = (name: string, bytes: Buffer | string): string => {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, bytes);
  return file;
};

describe("loadPrompt", () => {
  it("loads a real prompt off disk", () => {
    const prompt = loadPrompt("smoke.v1");

    expect(prompt).toContain("firstWords");
    // Trimmed on the way out, so a trailing newline in the file never becomes
    // trailing whitespace in the model input.
    expect(prompt).toBe(prompt.trim());
  });

  it("returns the identical cached string on a second read", () => {
    // Same reference, not merely equal: the cache exists so that a per-segment
    // loop does not stat the filesystem once per segment.
    expect(loadPrompt("smoke.v1")).toBe(loadPrompt("smoke.v1"));
  });

  it("names the missing prompt, the path, and what does exist", () => {
    // The failure this guards against is a model call with an empty system
    // prompt, which does not throw — it just quietly returns worse output.
    let message = "";
    try {
      loadPrompt("analyse.v1"); // British spelling: the plausible typo
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('Prompt "analyse.v1" not found');
    expect(message).toContain(path.join("src", "prompts", "analyse.v1.md"));
    // The whole point of the message: the correct name is right there.
    expect(message).toContain("smoke.v1");
  });

  it("rejects an empty prompt file rather than sending an empty prompt", () => {
    const promptDir = path.join(process.cwd(), "src", "prompts");
    const stray = path.join(promptDir, "__empty_fixture.v1.md");
    fs.writeFileSync(stray, "   \n\n  ");

    try {
      expect(() => loadPrompt("__empty_fixture.v1")).toThrow(/is empty/);
    } finally {
      fs.rmSync(stray, { force: true });
    }
  });
});

describe("audioPart", () => {
  it("reads a file into a base64 inline part with the documented mime type", () => {
    const bytes = Buffer.from("not really an mp3, but the bytes round-trip");
    const part = audioPart(writeFixture("clip.mp3", bytes));

    expect(part).toEqual({
      type: "audio",
      mime_type: "audio/mp3",
      data: bytes.toString("base64"),
    });
  });

  it("is case-insensitive about the extension", () => {
    const part = audioPart(writeFixture("CLIP.MP3", "x"));

    expect(part.type === "audio" && part.mime_type).toBe("audio/mp3");
  });

  it("maps each documented extension and refuses the rest", () => {
    expect(audioPart(writeFixture("a.wav", "x"))).toMatchObject({
      mime_type: "audio/wav",
    });
    expect(audioPart(writeFixture("a.flac", "x"))).toMatchObject({
      mime_type: "audio/flac",
    });

    // Removed on 2026-09-07: neither is in Gemini's documented set, and
    // accepting them advertised support that had never been verified.
    expect(() => audioPart(writeFixture("a.m4a", "x"))).toThrow(/Unsupported audio/);
    expect(() => audioPart(writeFixture("a.webm", "x"))).toThrow(/Unsupported audio/);
  });

  it("suggests the ffmpeg conversion in the unsupported-format error", () => {
    // A stage script pointed at the wrong file should not need to open this
    // module to find out what to do next.
    expect(() => audioPart(writeFixture("a.opus", "x"))).toThrow(/ffmpeg -i/);
  });

  it("names this file when it is over the inline cap", () => {
    // The reason this check exists at all: without it the request fails at the
    // API with a message about the request body, three frames from the cause.
    const tooBig = writeFixture("big.mp3", Buffer.alloc(15 * 1024 * 1024));

    expect(() => audioPart(tooBig)).toThrow(/big\.mp3 is 15\.0 MB/);
    expect(() => audioPart(tooBig)).toThrow(/inline request limit/);
  });

  it("accepts a file just under the cap", () => {
    // The boundary itself, so the cap cannot drift without a test noticing.
    const justUnder = writeFixture("edge.mp3", Buffer.alloc(14 * 1024 * 1024 - 1));

    expect(() => audioPart(justUnder)).not.toThrow();
  });
});

describe("ffmpegAvailable", () => {
  it("reports a version string or null, never throws", async () => {
    // Contract, not environment: the caller decides whether missing ffmpeg is
    // fatal, so this must resolve either way rather than reject.
    const version = await ffmpegAvailable();

    expect(version === null || typeof version === "string").toBe(true);
    if (version !== null) expect(version.length).toBeGreaterThan(0);
  });
});
