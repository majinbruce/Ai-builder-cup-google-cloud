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
