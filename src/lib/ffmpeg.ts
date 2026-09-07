import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * ffmpeg shells out from here, and only from here.
 *
 * Phase 0 needs one thing from it: whether it exists. From Phase 1 it does real
 * work — normalizing uploads to 16 kHz mono mp3, and running `silencedetect`
 * and `astats` to produce the measured pause and energy evidence that the
 * analyze prompt sees alongside the audio. That evidence is what makes the
 * prosody claim checkable rather than something the model merely asserts, so
 * ffmpeg is a hard dependency of the pipeline, not just of file conversion.
 */

/**
 * Returns ffmpeg's version string, or null when it is not on PATH.
 *
 * Null rather than a throw: the caller decides whether a missing ffmpeg is
 * fatal. It is not for the Phase 0 smoke test, which sends an already-encoded
 * mp3 inline; it is for every stage after that.
 */
export async function ffmpegAvailable(): Promise<string | null> {
  try {
    const { stdout } = await run("ffmpeg", ["-version"]);
    // "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) ..." -> "6.1.1-3ubuntu5"
    return stdout.split("\n")[0]?.split(" ")[2] ?? "unknown";
  } catch {
    return null;
  }
}
