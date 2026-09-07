/**
 * Strips secrets before anything is handed to the logger. Request bodies and
 * headers routinely carry passwords and bearer tokens, and log files are the
 * easiest place to leak them from.
 *
 * Pino's own `redact` option (wired up in app.ts) covers the fixed paths it
 * knows about — headers, body.password. This covers the shapes it cannot know
 * about: arbitrary error `details` payloads with nested, compound key names.
 */

/**
 * Matched as substrings, not exact keys — real payloads use compound names
 * like `managerPassword`, `workerPassword` or `clientSecret`, and an exact
 * match would let every one of them through.
 */
export const SENSITIVE_STEMS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apikey",
  "authorization",
  "cookie",
  "privatekey",
  "mnemonic",
  "seedphrase",
  "credential",
  "creditcard",
  "cvv",
] as const;

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;

export const isSensitive = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  return SENSITIVE_STEMS.some((stem) => normalized.includes(stem));
};

export const redact = (value: unknown, depth = 0): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(value)) {
    out[key] = isSensitive(key) ? REDACTED : redact(val, depth + 1);
  }

  return out;
};
