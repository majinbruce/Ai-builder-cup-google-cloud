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
 *
 * WRITES from the browser are the exception, since 2026-10-01: an upload goes
 * straight to GCS on a signed PUT URL (createUploadTarget below), because
 * Cloud Run refuses request bodies over 32 MiB. The service-account grant that
 * reason one above calls missing is now made by deploy.sh.
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
export const jobKey = (
  jobId: string,
  file: "source.mp3" | "output.mp3" | "source.mp4" | "output.mp4" | "poster.jpg"
): string => `jobs/${jobId}/${file}`;

/**
 * Where a browser's direct upload lands before it becomes a job.
 *
 * The user id is IN the key, so a job can only ever be created from an upload
 * under the caller's own prefix: ownership is the path, not a lookup. Objects
 * here are deleted once ingested, and a bucket lifecycle rule (deploy.sh)
 * removes abandoned ones after a day.
 */
export const uploadKey = (userId: string, uploadId: string): string =>
  `uploads/${userId}/${uploadId}`;

/** The URI a key has (or will have) on the configured backend. */
export function uriForKey(key: string): string {
  const bucket = config.gcs.bucket;
  return bucket === null ? path.join(LOCAL_ROOT, key) : `${GCS_SCHEME}${bucket}/${key}`;
}

const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
};

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
    .upload(localPath, {
      destination: key,
      contentType: CONTENT_TYPES[path.extname(key)] ?? "application/octet-stream",
    });
  return `${GCS_SCHEME}${bucket}/${key}`;
}

/** Deletes a stored file. Missing is fine: the goal is that it is gone. */
export async function deleteFile(uri: string): Promise<void> {
  const location = parseStorageUri(uri);

  if (location.backend === "local") {
    await fsp.rm(location.filePath, { force: true });
    return;
  }

  await getGcs()
    .bucket(location.bucket)
    .file(location.key)
    .delete({ ignoreNotFound: true });
}

/**
 * Deletes every file a job has, by its key prefix rather than a list of names,
 * so a file type added later cannot be left behind by a delete written now.
 */
export async function deleteJobFiles(jobId: string): Promise<void> {
  const prefix = `jobs/${jobId}/`;
  const bucket = config.gcs.bucket;

  if (bucket === null) {
    await fsp.rm(path.join(LOCAL_ROOT, prefix), { recursive: true, force: true });
    return;
  }

  await getGcs().bucket(bucket).deleteFiles({ prefix, force: true });
}

/** How long a signed upload URL stays valid. Long enough for 100 MB on a slow link. */
export const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;

export interface UploadTarget {
  /** Absolute (GCS) or same-origin relative (local backend). */
  url: string;
  method: "PUT";
  /** Must be sent exactly: both are part of the V4 signature. */
  headers: Record<string, string>;
  expiresAt: string;
}

/**
 * A URL the BROWSER uploads the file to, without the bytes touching our API.
 *
 * Why this exists: Cloud Run refuses HTTP/1 request bodies over 32 MiB, and an
 * upload through the web service and then the API is two of them. A V4 signed
 * PUT goes straight to GCS, which has no such cap.
 *
 * The size cap travels inside the signature as `x-goog-content-length-range`,
 * so GCS itself rejects a larger body — the browser cannot drop the header or
 * change it without invalidating the signature. Same for Content-Type.
 *
 * Signing on Cloud Run has no private key to sign with: the client library
 * calls IAM signBlob as the runtime service account, which needs
 * roles/iam.serviceAccountTokenCreator ON ITSELF (granted in deploy.sh).
 *
 * The local backend has no GCS to sign for, so it returns an API route that
 * accepts the PUT instead (localize.routes.ts, registered only without a bucket).
 */
export async function createUploadTarget(
  key: string,
  uploadId: string,
  contentType: string,
  maxBytes: number
): Promise<UploadTarget> {
  const expires = Date.now() + UPLOAD_URL_TTL_MS;
  const expiresAt = new Date(expires).toISOString();
  const bucket = config.gcs.bucket;

  if (bucket === null) {
    return {
      url: `/api/v1/localize/uploads/${uploadId}`,
      method: "PUT",
      headers: { "Content-Type": contentType },
      expiresAt,
    };
  }

  const lengthRange = `0,${maxBytes}`;
  const [url] = await getGcs()
    .bucket(bucket)
    .file(key)
    .getSignedUrl({
      version: "v4",
      action: "write",
      expires,
      contentType,
      extensionHeaders: { "x-goog-content-length-range": lengthRange },
    });

  return {
    url,
    method: "PUT",
    headers: { "Content-Type": contentType, "x-goog-content-length-range": lengthRange },
    expiresAt,
  };
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
 * The most one ranged response carries.
 *
 * Cloud Run refuses an HTTP/1 response over 32 MiB that is not chunked
 * (docs/research.md § Cloud Run; measured 2026-10-01: a 38 MiB video answered
 * `Range: bytes=0-` with a 500). A <video> opens with exactly that open-ended
 * range. HTTP lets a server answer a range with a SHORTER one — Content-Range
 * says what was sent — and media elements simply ask for the next piece, so
 * capping the piece is the standard fix rather than a workaround.
 */
export const MAX_RANGE_BYTES = 8 * 1024 * 1024;

/** Shortens a satisfiable range to at most MAX_RANGE_BYTES. Pure. */
export function capRange(range: ByteRange, max = MAX_RANGE_BYTES): ByteRange {
  return { start: range.start, end: Math.min(range.end, range.start + max - 1) };
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
