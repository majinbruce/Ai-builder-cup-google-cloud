import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
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

/**
 * Everything below is measurement, not conversion.
 *
 * docs/SPEC.md section f moved acoustic evidence out of the fallback list and
 * into Phase 1 as core, for a reason recorded in docs/JUDGE_NOTES.md: the Phase
 * 0 smoke run could not distinguish "the model heard stress on that word" from
 * "the model inferred stress from the meaning of the sentence". These functions
 * produce the numbers that settle it. They are deliberately dumb — shell out,
 * parse, return. Every judgement about what a number MEANS lives in
 * src/modules/localize/acoustics.ts, so that the parsing can be unit-tested
 * against captured ffmpeg text with no audio file and no ffmpeg binary.
 */

/** ffmpeg writes its analysis filters to stderr, and can produce a lot of it. */
const MAX_FFMPEG_OUTPUT_BYTES = 16 * 1024 * 1024;

/** One measured silent stretch, in seconds from the start of the clip. */
export interface Silence {
  startSec: number;
  endSec: number;
  durationSec: number;
}

/** Mean RMS level of one fixed-width window, in dBFS. */
export interface RmsWindow {
  startSec: number;
  rmsDb: number;
}

/**
 * Clip length in seconds, from the container.
 *
 * ffprobe rather than ffmpeg: the duration is metadata, and decoding a whole
 * file to learn how long it is would triple the cost of every measurement pass.
 */
export async function probeDurationSec(filePath: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);

  const durationSec = Number.parseFloat(stdout.trim());

  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(
      `ffprobe could not read a duration from ${filePath} (got "${stdout.trim()}"). ` +
        "The file is probably not decodable audio."
    );
  }

  return durationSec;
}

/**
 * Parses `volumedetect`'s mean level out of ffmpeg's stderr.
 *
 * Split from the shelling so the format assumption is testable. The line looks
 * like: `[Parsed_volumedetect_0 @ 0x...] mean_volume: -16.4 dB`
 */
export function parseMeanVolumeDb(ffmpegStderr: string): number {
  const match = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(ffmpegStderr);

  if (match?.[1] === undefined) {
    throw new Error(
      "ffmpeg volumedetect produced no mean_volume line. Output was:\n" +
        ffmpegStderr.slice(0, 500)
    );
  }

  return Number.parseFloat(match[1]);
}

/**
 * The clip's mean level in dBFS.
 *
 * This exists because a fixed silence threshold is wrong for every clip that is
 * not the one it was tuned on — fixtures/README.md records the source clip
 * averaging -45 dB, where a -30 dB threshold called the entire recording
 * silent. The threshold that actually gets used is derived from this number in
 * acoustics.ts.
 */
export async function measureMeanVolumeDb(filePath: string): Promise<number> {
  const { stderr } = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      filePath,
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: MAX_FFMPEG_OUTPUT_BYTES }
  );

  return parseMeanVolumeDb(stderr);
}

/**
 * Parses `silencedetect`'s stderr into complete silences.
 *
 * A silence that is still open when the clip ends has a `silence_start` and no
 * `silence_end`; it is dropped rather than closed at the duration, because
 * trailing room tone is not a pedagogical pause and counting it would inflate
 * the density figure the threshold ladder steers by.
 */
export function parseSilences(ffmpegStderr: string): Silence[] {
  const silences: Silence[] = [];
  let openStart: number | null = null;

  for (const line of ffmpegStderr.split("\n")) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (start?.[1] !== undefined) {
      openStart = Number.parseFloat(start[1]);
      continue;
    }

    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (end?.[1] !== undefined && openStart !== null) {
      const endSec = Number.parseFloat(end[1]);
      silences.push({
        startSec: openStart,
        endSec,
        durationSec: endSec - openStart,
      });
      openStart = null;
    }
  }

  return silences;
}

/**
 * Runs `silencedetect` at an explicit threshold.
 *
 * The threshold is a required argument with no default on purpose: there is no
 * defensible fixed value, and a default would be one waiting to be used by
 * accident. acoustics.ts picks it per clip.
 */
export async function detectSilences(
  filePath: string,
  thresholdDb: number,
  minDurationSec: number
): Promise<Silence[]> {
  const { stderr } = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      filePath,
      "-af",
      `silencedetect=noise=${thresholdDb}dB:d=${minDurationSec}`,
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: MAX_FFMPEG_OUTPUT_BYTES }
  );

  return parseSilences(stderr);
}

/**
 * Parses the `ametadata=print` stream into a windowed RMS series.
 *
 * The output alternates a frame header and a value:
 *
 *   frame:3    pts:24000   pts_time:1.5
 *   lavfi.astats.Overall.RMS_level=-15.591943
 *
 * Digital silence reports `-inf`, which is not a number Zod or arithmetic can
 * use; it is floored at -120 dBFS, below anything a microphone produces.
 */
export function parseRmsWindows(ametadataStdout: string): RmsWindow[] {
  const windows: RmsWindow[] = [];
  let pendingTime: number | null = null;

  for (const line of ametadataStdout.split("\n")) {
    const frame = /pts_time:(-?\d+(?:\.\d+)?)/.exec(line);
    if (frame?.[1] !== undefined) {
      pendingTime = Number.parseFloat(frame[1]);
      continue;
    }

    const value = /RMS_level=(-?(?:\d+(?:\.\d+)?|inf))/.exec(line);
    if (value?.[1] !== undefined && pendingTime !== null) {
      const raw = value[1];
      windows.push({
        startSec: pendingTime,
        rmsDb: raw.endsWith("inf") ? -120 : Number.parseFloat(raw),
      });
      pendingTime = null;
    }
  }

  return windows;
}

/**
 * Per-window RMS energy across the clip.
 *
 * `asetnsamples` rewrites the frame size so that one astats reset covers
 * exactly one window, `reset=1` restarts the statistics every frame, and
 * `ametadata=print` writes the per-frame value to stdout. Measured on
 * fixtures/sample_60s.mp3: 127 windows over 63.1 s at 0.5 s resolution.
 *
 * @param sampleRate must match the clip; the pipeline normalizes to 16 kHz, and
 *                   the window is expressed in samples because that is what the
 *                   filter takes.
 */
export async function measureRmsWindows(
  filePath: string,
  windowSec: number,
  sampleRate: number
): Promise<RmsWindow[]> {
  const samplesPerWindow = Math.max(1, Math.round(windowSec * sampleRate));

  const { stdout } = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      filePath,
      "-af",
      `aresample=${sampleRate},asetnsamples=n=${samplesPerWindow},` +
        "astats=metadata=1:reset=1," +
        "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: MAX_FFMPEG_OUTPUT_BYTES }
  );

  const windows = parseRmsWindows(stdout);

  if (windows.length === 0) {
    throw new Error(
      `ffmpeg astats produced no RMS windows for ${filePath}. The file may be ` +
        "empty or not decodable as audio."
    );
  }

  return windows;
}

/**
 * ============================================================================
 * Assembly — Phase 3. Turning per-segment synthesis into one playable file.
 * ============================================================================
 */

/**
 * Escapes one path for ffmpeg's concat demuxer list format.
 *
 * Two separate hazards, both handled here rather than at the call site.
 *
 * Quoting: the list is `file '<path>'` lines, and a single quote inside a path
 * ends the quoting early. The documented escape is to close the quote, emit a
 * literal backslash-quote, and reopen. A path with a quote in it is unlikely
 * while we generate the names, and it stops being unlikely in Phase 4 when job
 * ids reach the filesystem.
 *
 * Absolutization: the demuxer resolves a relative path in the list against the
 * LIST FILE's directory, not the process working directory. Measured 2026-09-08
 * — passing `outputs/segments/s01.wav` in a list written to `outputs/` made
 * ffmpeg look for `outputs/outputs/segments/s01.wav` and fail. Resolving here
 * means no caller has to know that, and a relative path is not silently
 * reinterpreted.
 */
export function escapeConcatPath(filePath: string): string {
  return `file '${path.resolve(filePath).replace(/'/g, "'\\''")}'`;
}

/**
 * Concatenates same-format audio files into one.
 *
 * The concat DEMUXER (`-f concat`) rather than the filter, because the inputs
 * are all LINEAR16 WAV from the same voice at the same sample rate, so this is a
 * byte-level join with no re-encode and no resampling — the output duration is
 * exactly the sum of the inputs. That property is load-bearing for Phase 3,
 * which measures real durations to replace an estimated constant: a join that
 * quietly added or dropped milliseconds would corrupt the measurement it exists
 * to enable.
 */
export async function concatAudio(inputPaths: string[], outPath: string): Promise<void> {
  if (inputPaths.length === 0) {
    throw new Error("concatAudio was given no inputs. There is nothing to join.");
  }

  const listPath = `${outPath}.concat.txt`;
  await fsp.writeFile(listPath, inputPaths.map(escapeConcatPath).join("\n"), "utf8");

  try {
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        outPath,
      ],
      { maxBuffer: MAX_FFMPEG_OUTPUT_BYTES }
    );
  } finally {
    await fsp.rm(listPath, { force: true });
  }
}

/**
 * Encodes to the pipeline's canonical 16 kHz mono MP3.
 *
 * The same format ingest normalizes uploads to (docs/SPEC.md stage 0), so
 * `output.mp3` and `source.mp3` are the same shape and the side-by-side player
 * in Phase 4 has one decoder path rather than two.
 */
export async function encodeMp3(inPath: string, outPath: string): Promise<void> {
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-y",
      "-i",
      inPath,
      // No video stream in, no video stream out. Without this an mp4 upload
      // makes ffmpeg try to map its picture into an mp3 and fail; with it, the
      // same call is both stage 0's ingest normalizer and stage 4's encoder.
      "-vn",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-codec:a",
      "libmp3lame",
      "-q:a",
      "4",
      outPath,
    ],
    { maxBuffer: MAX_FFMPEG_OUTPUT_BYTES }
  );
}

/**
 * Video codecs current browsers play inside mp4. A video track in anything else
 * would mux fine and then show a black box, so it is treated as no video.
 */
const PLAYABLE_VIDEO_CODECS = new Set(["h264", "hevc", "vp9", "av1"]);

/**
 * Parses ffprobe's `codec_name,attached_pic` csv rows into "is there a real,
 * playable picture". Split from the shelling so it is testable.
 *
 * An mp3 or m4a with cover art reports its artwork as a video stream (mjpeg or
 * png with `attached_pic=1`). That is a still image, not footage, and a job
 * built from it must stay audio-only.
 */
export function parseHasPlayableVideo(ffprobeCsv: string): boolean {
  return ffprobeCsv
    .split("\n")
    .map((line) => line.trim().split(","))
    .some(
      ([codec = "", attachedPic = "0"]) =>
        PLAYABLE_VIDEO_CODECS.has(codec) && attachedPic !== "1"
    );
}

/** Whether a file carries footage a browser can play. */
export async function probeHasPlayableVideo(filePath: string): Promise<boolean> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v",
    "-show_entries",
    "stream=codec_name:stream_disposition=attached_pic",
    "-of",
    "csv=p=0",
    filePath,
  ]);
  return parseHasPlayableVideo(stdout);
}

/**
 * One frame of the footage as a small JPEG, for the library grid.
 *
 * Taken a little way in rather than at 0 s, where lectures are often a black
 * fade or a title card. 640 px wide is enough for a card at 2x density.
 */
export async function extractPoster(
  videoPath: string,
  outPath: string,
  atSec: number
): Promise<void> {
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-y",
      "-ss",
      atSec.toFixed(2),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=640:-2",
      "-q:v",
      "4",
      outPath,
    ],
    { maxBuffer: MAX_FFMPEG_OUTPUT_BYTES }
  );
}

/**
 * The source footage with the synthesized audio under it.
 *
 * The picture is COPIED, not re-encoded: a two-minute 1080p re-encode on one
 * Cloud Run vCPU would cost more than the whole synthesis stage, and copying
 * is lossless. Only the audio is encoded, to AAC, because mp4 players expect it.
 *
 * No `-shortest`. Stage 4 fits the audio to the source's length, but when an
 * utterance hits its speed-up cap the Hindi runs a little long, and cutting it
 * at the last frame would drop the end of the lesson. The player holds the last
 * frame instead. `+faststart` puts the index first, so playback and seeking
 * start before the whole file has downloaded.
 */
export async function muxVideoWithAudio(
  videoPath: string,
  audioPath: string,
  outPath: string
): Promise<void> {
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outPath,
    ],
    { maxBuffer: MAX_FFMPEG_OUTPUT_BYTES }
  );
}
