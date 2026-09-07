import "server-only";
import { z } from "zod";

/**
 * ============================================================================
 * The only file in this app that reads `process.env`.
 * ============================================================================
 *
 * The API enforces the same rule (see the backend's src/config/index.ts) and it
 * matters more here than it looks, because Next.js has two places a variable
 * can be read from and they behave completely differently:
 *
 *   - `NEXT_PUBLIC_*` is INLINED INTO THE BUNDLE AT BUILD TIME. Changing it
 *     means rebuilding the image. For a boilerplate that is cloned per project
 *     and deployed as one container per project, that is the wrong trade: the
 *     same image should be configurable by the environment it starts in.
 *
 *   - everything else is read at RUNTIME, but only on the server.
 *
 * So this app has no `NEXT_PUBLIC_` variables at all. Everything is read here,
 * on the server, at runtime; the handful of values the browser genuinely needs
 * are handed to it as props from the root layout — see `site-config.ts`.
 *
 * `import "server-only"` makes that a build error rather than a convention: if
 * a client component ever imports this file, the build fails instead of
 * shipping the whole environment to the browser.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  /**
   * The public origin this app is served from. Used for `metadataBase` (so
   * OpenGraph URLs resolve) and nothing else — the browser never needs it,
   * because it only ever calls relative paths.
   */
  APP_URL: z.url().default("http://localhost:3001"),

  /**
   * How SERVER components reach the API. Not the browser's path: in production
   * this is the Docker network name (`http://api:3000`), which is unreachable
   * and meaningless outside the compose network. The browser uses `/api/...`.
   */
  API_ORIGIN: z.url().default("http://127.0.0.1:3000"),

  /** Branding. Matches APP_NAME on the API so the emails and the UI agree. */
  APP_NAME: z.string().min(1).max(60).default("Acme"),

  /**
   * Note what is NOT here: any flag describing what the API can authenticate
   * with. Which social providers exist, and whether email verification is
   * required, are facts about the API process — mirroring them here creates two
   * settings that must agree and silently do not. They are read from
   * `GET /api/auth/providers` instead; see site-config.server.ts.
   */
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail at boot with every problem listed, rather than at the first request
  // with `undefined is not a valid URL` from three frames deep.
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid environment variables:\n${issues}`);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";
