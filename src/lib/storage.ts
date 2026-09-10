import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Storage } from "@google-cloud/storage";
import { config } from "../config/index.ts";

/**
 * ============================================================================
 * Where job files live. The only module that knows GCS exists.
 * ============================================================================
 *
 * Two backends behind one interface, chosen by `config.gcs.bucket`:
 *
 *   bucket set   gs://<bucket>/<key>, via @google-cloud/storage and Application
 *                Default Credentials — the same ADC Cloud TTS already uses.
 *   bucket null  a plain directory, outputs/storage/<key>. How a fresh clone,
 *                the integration suite and the local e2e run work with no GCP
 *                project at all. Production refuses to boot in this mode (see
 *                the GCS_BUCKET refine in config), because Cloud Run's disk is
 *                gone the moment the instance is recycled.
 *
 * A stored file is addressed by its URI, not by its key, and the URI is what
 * goes in the database. That way a row says which backend holds its bytes: a job
 * written by a local run and read by a GCS-configured process fails loudly on
 * the scheme instead of looking for the key in the wrong place.
 *
 * Reads are streams with an optional byte range, not signed URLs. SPEC section b
 * originally said "signed GCS redirect"; streaming replaced it in Phase 4 for
 * three reasons, recorded there. V4 signing on Cloud Run needs the runtime
 * service account granted `iam.serviceAccountTokenCreator` on itself, a
 * permission that is missing by default and only shows up on deploy day. A
 * signed URL is also a bearer link that skips the owner check for its lifetime.
 * And the player seeks to a segment's start, which needs HTTP Range, which a
 * range-aware stream gives both backends identically.
 */

/** Local backend root. Under outputs/, which is already gitignored. */
const LOCAL_ROOT = path.resolve("outputs", "storage");

const GCS_SCHEME = "gs://";

let gcs: Storage | null = null;

/** Lazily built, like the Gemini and TTS clients: importing must not need ADC. */
function getGcs(): Storage {
  gcs ??= new Storage();
  return gcs;
}

/** The key layout for one job's files. The only place it is spelled out. */
export const jobKey = (jobId: string, file: "source.mp3" | "output.mp3"): string =>
  `jobs/${jobId}/${file}`;

type Location =
  | { backend: "gcs"; bucket: string; key: string }
  | { backend: "local"; filePath: string };

/**
 * URI to a concrete location, refusing anything that is neither.
 *
 * Local URIs are absolute paths and must resolve inside LOCAL_ROOT. The URI
 * came out of our own database, so this is not defending against a caller; it
 * is making sure a corrupted or hand-edited row cannot turn the audio route
 * into a read of an arbitrary file on the box.
 */
export function parseStorageUri(uri: string): Location {
  if (uri.startsWith(GCS_SCHEME)) {
    const rest = uri.slice(GCS_SCHEME.length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) {
      throw new Error(`Malformed GCS URI "${uri}". Expected gs://<bucket>/<key>.`);
    }
    return { backend: "gcs", bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
  }

  const filePath = path.resolve(uri);
  if (!filePath.startsWith(LOCAL_ROOT + path.sep)) {
    throw new Error(
      `Storage URI "${uri}" is neither gs:// nor inside ${LOCAL_ROOT}. Refusing to ` +
        "read it — a stored URI must point at a file this module wrote."
    );
  }
  return { backend: "local", filePath };
}

/** Uploads a local file under `key` and returns its URI. */
export async function putFile(localPath: string, key: string): Promise<string> {
  const bucket = config.gcs.bucket;

  if (bucket === null) {
    const target = path.join(LOCAL_ROOT, key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(localPath, target);
    return target;
  }

  await getGcs()
    .bucket(bucket)
    .upload(localPath, { destination: key, contentType: "audio/mpeg" });
  return `${GCS_SCHEME}${bucket}/${key}`;
}

/** Copies a stored file to a local path, so ffmpeg and Gemini can read it. */
export async function downloadFile(uri: string, localPath: string): Promise<void> {
  const location = parseStorageUri(uri);

  if (location.backend === "local") {
    await fsp.copyFile(location.filePath, localPath);
    return;
  }

  await getGcs()
    .bucket(location.bucket)
    .file(location.key)
    .download({ destination: localPath });
}

/** Size in bytes, needed to answer a Range request before streaming anything. */
export async function fileSize(uri: string): Promise<number> {
  const location = parseStorageUri(uri);

  if (location.backend === "local") {
    return (await fsp.stat(location.filePath)).size;
  }

  const [metadata] = await getGcs()
    .bucket(location.bucket)
    .file(location.key)
    .getMetadata();
  return Number(metadata.size);
}

/** Inclusive byte range, the way HTTP and both backends express it. */
export interface ByteRange {
  start: number;
  end: number;
}

export function openReadStream(uri: string, range?: ByteRange): Readable {
  const location = parseStorageUri(uri);
  const bounds = range === undefined ? {} : { start: range.start, end: range.end };

  if (location.backend === "local") {
    return fs.createReadStream(location.filePath, bounds);
  }

  return (
    getGcs()
      .bucket(location.bucket)
      .file(location.key)
      // Validation off for ranged reads: a CRC check over a partial object
      // always fails, and the whole-object check is GCS's job on upload.
      .createReadStream({ ...bounds, validation: range === undefined ? "crc32c" : false })
  );
}

/** Writes a stream to disk. Used by ingest to land the upload before ffmpeg. */
export async function writeStreamToFile(
  stream: Readable,
  localPath: string
): Promise<void> {
  await pipeline(stream, fs.createWriteStream(localPath));
}

/**
 * Parses an HTTP `Range` header against a known size.
 *
 * Only the single-range `bytes=` form, because that is all an <audio> element
 * ever sends. Returns:
 *   - undefined  no header: serve the whole file with a 200
 *   - null       a header we cannot satisfy: 416
 *   - a range    serve it with a 206
 *
 * Multi-range requests are answered as unsatisfiable rather than with their
 * first range: a single-part answer to a multipart/byteranges request is a
 * malformed response, and no browser media stack sends one anyway.
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number
): ByteRange | null | undefined {
  if (header === undefined || header.trim() === "") return undefined;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || size === 0) return null;

  const [, rawStart = "", rawEnd = ""] = match;

  if (rawStart === "" && rawEnd === "") return null;

  // "bytes=-500" is a suffix range: the last 500 bytes.
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);

  if (start >= size || end < start) return null;

  return { start, end };
}
