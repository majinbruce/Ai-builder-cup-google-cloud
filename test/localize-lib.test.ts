import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ffmpegAvailable,
  loudnessGainFilter,
  parseLoudnessMeasurement,
} from "../src/lib/ffmpeg.ts";
import { audioPart, parseThinkingLevel, THINKING_LEVELS } from "../src/lib/gemini.ts";
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

describe("parseThinkingLevel", () => {
  it("returns undefined when the flag is absent, meaning the model's default", () => {
    expect(parseThinkingLevel(["--no-audio", "--from-analysis"])).toBeUndefined();
  });

  it("accepts every level the model actually supports", () => {
    for (const level of THINKING_LEVELS) {
      expect(parseThinkingLevel([`--thinking=${level}`])).toBe(level);
    }
  });

  /**
   * The reason this function exists rather than a cast at the call site.
   *
   * `"minimal"` is in the SDK's union type and is a measured 400 on
   * gemini-3.8-flash (docs/research.md). A `as ThinkingLevel` cast compiles
   * fine and fails at the API — on the full pipeline, AFTER the analyze and
   * brief calls have been paid for. Failing before the first request is the
   * whole point.
   */
  it("rejects the level the SDK offers but the model 400s on", () => {
    expect(() => parseThinkingLevel(["--thinking=minimal"])).toThrow(/minimal/);
  });

  it("rejects a typo rather than sending it", () => {
    expect(() => parseThinkingLevel(["--thinking=lwo"])).toThrow(/low, medium, high/);
  });

  it("rejects an empty value", () => {
    expect(() => parseThinkingLevel(["--thinking="])).toThrow();
  });
});

describe("parseLoudnessMeasurement", () => {
  // The tail of a real `loudnorm=print_format=json` run on the first prod demo.
  const report = (inputI: string) => `size=N/A time=00:01:03.01 bitrate=N/A speed= 120x
[Parsed_loudnorm_0 @ 0x5f0c] 
{
	"input_i" : "${inputI}",
	"input_tp" : "-30.79",
	"input_lra" : "6.40",
	"input_thresh" : "-55.31",
	"output_i" : "-16.20",
	"output_tp" : "-1.50",
	"output_lra" : "5.10",
	"output_thresh" : "-26.40",
	"normalization_type" : "dynamic",
	"target_offset" : "0.20"
}
`;

  it("reads the measured values pass two needs", () => {
    expect(parseLoudnessMeasurement(report("-45.02"))).toEqual({
      inputI: -45.02,
      inputTp: -30.79,
    });
  });

  it("returns null for silence, which no gain can bring to the target", () => {
    expect(parseLoudnessMeasurement(report("-inf"))).toBeNull();
  });

  it("throws when there is no report", () => {
    expect(() => parseLoudnessMeasurement("Error opening input")).toThrow(/no JSON/);
  });

  it("applies one gain when the peak has room for it", () => {
    // -45.02 LUFS to -16 is +29.02 dB; the -30.79 dBTP peak ends at -1.77.
    const measured = parseLoudnessMeasurement(report("-45.02"));
    expect(measured).not.toBeNull();
    expect(loudnessGainFilter(measured!)).toBe("volume=29.02dB");
  });

  it("holds the peak with a limiter instead of riding the gain", () => {
    // A real Gemini TTS join: -17.96 LUFS peaking at -0.98 dBTP. +1.96 dB would
    // put the peak at +0.98, which is where loudnorm's linear mode silently
    // turned dynamic and leveled the delivery out.
    const filter = loudnessGainFilter({ inputI: -17.96, inputTp: -0.98 });
    expect(filter).toBe(
      "volume=1.96dB,alimiter=limit=0.8414:attack=5:release=100:level=false:latency=true"
    );
    expect(filter).not.toContain("loudnorm");
  });

  it("turns a loud clip down with no limiter at all", () => {
    expect(loudnessGainFilter({ inputI: -12, inputTp: -0.5 })).toBe("volume=-4.00dB");
  });
});
