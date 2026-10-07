/**
 * Just enough RIFF/WAVE to make silence that concatenates losslessly.
 *
 * Stage 4 places each utterance on the source timeline, so the gaps between
 * them are silence the pipeline writes itself. ffmpeg's concat demuxer joins
 * with `-c copy`, which only works when every input has the SAME sample rate,
 * channel count and sample width — so the silence is built to mirror whatever
 * Cloud TTS returned, read from that file's own header rather than assumed.
 */

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/**
 * Reads the format from a canonical PCM WAV header.
 *
 * Walks the chunks instead of reading fixed offsets: a writer may put a LIST
 * chunk before `fmt `, and a fixed offset would then read garbage as a rate.
 */
export function readPcmFormat(wav: Buffer): PcmFormat {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE buffer; cannot read its PCM format.");
  }

  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      return {
        channels: wav.readUInt16LE(offset + 10),
        sampleRate: wav.readUInt32LE(offset + 12),
        bitsPerSample: wav.readUInt16LE(offset + 22),
      };
    }
    // Chunks are word-aligned: an odd size is followed by one pad byte.
    offset += 8 + size + (size % 2);
  }

  throw new Error("WAV buffer has no fmt chunk; cannot read its PCM format.");
}

/** A PCM WAV of `sec` seconds of digital silence in the given format. */
export function silenceWav(sec: number, format: PcmFormat): Buffer {
  const { sampleRate, channels, bitsPerSample } = format;
  const blockAlign = channels * (bitsPerSample / 8);
  const frames = Math.max(0, Math.round(sec * sampleRate));
  const dataBytes = frames * blockAlign;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);

  // Buffer.alloc zero-fills, and zero is silence for signed 16-bit PCM.
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

/** Wraps raw little-endian PCM in a canonical 44-byte WAV header. */
export function pcmToWav(pcm: Buffer, format: PcmFormat): Buffer {
  const header = silenceWav(0, format);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * The samples of a 16-bit mono PCM WAV, with its format.
 *
 * For stage 4's takes, which conformSpeech() has already written as 16-bit
 * mono; anything else is refused rather than read as if it were.
 */
export function readMono16(wav: Buffer): { format: PcmFormat; samples: Int16Array } {
  const format = readPcmFormat(wav);
  if (format.channels !== 1 || format.bitsPerSample !== 16) {
    throw new Error(
      `Expected 16-bit mono PCM, got ${format.bitsPerSample}-bit with ` +
        `${format.channels} channel(s).`
    );
  }

  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") {
      // Clamped to the bytes present: ffmpeg writes the data size last, and a
      // header that overstates it must not read past the buffer.
      const count = Math.floor(Math.min(size, wav.length - offset - 8) / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i += 1) {
        samples[i] = wav.readInt16LE(offset + 8 + i * 2);
      }
      return { format, samples };
    }
    offset += 8 + size + (size % 2);
  }

  throw new Error("WAV buffer has no data chunk; there are no samples to read.");
}

/** One quiet stretch of a take, in seconds from its start. */
export interface QuietRun {
  startSec: number;
  endSec: number;
}

/** Level is judged over frames this long: short enough to find a pause's edge. */
const QUIET_FRAME_SEC = 0.01;

/**
 * Stretches where every 10 ms frame is at or below `thresholdDb` (RMS, dBFS)
 * for at least `minSec`. Pure.
 *
 * RMS over a frame rather than ffmpeg silencedetect's per-sample test, where a
 * single stray sample over the threshold ends a pause. Measured on one clip:
 * 0.5 s of near-silence with a few such samples was not a pause to ffmpeg at
 * all.
 */
export function findQuietRuns(
  samples: Int16Array,
  sampleRate: number,
  options: { thresholdDb: number; minSec: number }
): QuietRun[] {
  const frame = Math.max(1, Math.round(sampleRate * QUIET_FRAME_SEC));
  const frames = Math.floor(samples.length / frame);
  // Compared as mean square, so no logarithm per frame.
  const limit = 10 ** (options.thresholdDb / 10) * 32768 * 32768;

  const runs: QuietRun[] = [];
  let open = -1;
  for (let f = 0; f <= frames; f += 1) {
    let quiet = false;
    if (f < frames) {
      let sum = 0;
      for (let i = f * frame; i < (f + 1) * frame; i += 1) {
        const sample = samples[i] ?? 0;
        sum += sample * sample;
      }
      quiet = sum / frame <= limit;
    }

    if (quiet && open === -1) open = f;
    if (!quiet && open !== -1) {
      const startSec = (open * frame) / sampleRate;
      const endSec = (f * frame) / sampleRate;
      if (endSec - startSec >= options.minSec) runs.push({ startSec, endSec });
      open = -1;
    }
  }

  return runs;
}

/**
 * A WAV of `samples[start, end)`, faded in and out over `fadeSec`.
 *
 * The fade is what makes a cut inside a pause inaudible: a pause in a take is
 * breath and noise floor, not zeros, and a hard edge against the digital
 * silence written around it can click.
 */
export function sliceMono16(
  samples: Int16Array,
  format: PcmFormat,
  start: number,
  end: number,
  fadeSec = 0.005
): Buffer {
  const from = Math.max(0, Math.min(samples.length, Math.round(start)));
  const to = Math.max(from, Math.min(samples.length, Math.round(end)));
  const count = to - from;
  const fade = Math.min(Math.round(format.sampleRate * fadeSec), Math.floor(count / 2));

  const pcm = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    const edge = Math.min(i, count - 1 - i);
    const gain = edge < fade ? edge / fade : 1;
    pcm.writeInt16LE(Math.round((samples[from + i] ?? 0) * gain), i * 2);
  }

  return pcmToWav(pcm, format);
}
