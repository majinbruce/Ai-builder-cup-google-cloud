import path from "node:path";
import process from "node:process";
import { config as loadEnvFile } from "dotenv";
import { z } from "zod";

/**
 * Configuration is parsed once, at boot, into a frozen typed object. Nothing
 * else in the app reads process.env — so a missing or malformed variable is a
 * startup crash with a precise message, never a mysterious `undefined` three
 * hours into a deploy.
 *
 * This replaces dotenv-safe: the schema below IS the contract that .env.example
 * used to express, except it also coerces types and carries defaults.
 */

const VALID_ENVS = ["development", "production", "test"] as const;

/**
 * The secrets this repository ships with, verbatim. They live in committed
 * files (.env.example, .env.test), so they are public — anybody who has seen
 * the boilerplate can forge a session cookie signed with one. Refused in
 * production below; see that refine for why a substring check is not enough.
 */
const PUBLISHED_SECRETS = new Set([
  "dev-only-better-auth-secret-change-me-32",
  "test-only-better-auth-secret-not-used-anywhere-32",
]);

// Bracket access because `noPropertyAccessFromIndexSignature` is on: process.env
// is an index signature, and dot access hides the fact that the key may not exist.
const nodeEnv = process.env["NODE_ENV"] ?? "development";

if (!VALID_ENVS.includes(nodeEnv as (typeof VALID_ENVS)[number])) {
  throw new Error(
    `Invalid NODE_ENV "${nodeEnv}". Expected one of: ${VALID_ENVS.join(", ")}`
  );
}

// Real environment variables always win over the file, which is what container
// platforms (ECS, Cloud Run, k8s) inject. The file is a local-dev convenience.
loadEnvFile({
  path: path.resolve(process.cwd(), `.env.${nodeEnv}`),
  quiet: true,
});

/**
 * `z.coerce.boolean()` is the wrong tool for environment variables: it applies
 * JavaScript truthiness, so the string "false" coerces to `true` and a flag you
 * explicitly turned off silently stays on. Parsing the literal instead means a
 * typo ("FALSE", "0", "no") is a boot-time error rather than a surprise.
 */
const envBoolean = z.enum(["true", "false"]).transform((value) => value === "true");

/**
 * `z.coerce` is deliberate: every value out of process.env is a string, and
 * without coercion `PORT` would be "3000" and every numeric comparison in the
 * app would be subtly wrong.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(VALID_ENVS).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .optional(),

  CORS_ORIGINS: z.string().default("*"),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),

  /**
   * How many reverse proxies sit in front of this process.
   *
   * `false` means "read the socket address" — right when nothing is in front of
   * you. A number means "trust that many hops at the right-hand end of
   * X-Forwarded-For". A CIDR or comma-separated list means "trust these peers".
   *
   * It is NOT a plain boolean-on by default, and that is the whole point:
   * `trustProxy: true` trusts an X-Forwarded-For header from anybody, so a
   * client hitting the app directly can name its own `request.ip` — and
   * `request.ip` is the rate-limit key protecting sign-in and password reset.
   */
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((value) => {
      if (value === "false") return false as const;
      if (value === "true") return true as const;

      const hops = Number(value);
      return Number.isInteger(hops) && hops > 0 ? hops : value;
    }),

  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  /* ---- Better Auth ------------------------------------------------------ */

  // Signs session tokens and encrypts stored OAuth tokens. No default, on
  // purpose: a boilerplate that ships with a fallback secret is how "change-me"
  // ends up signing production sessions. Generate one with `npm run auth:secret`.
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),

  /**
   * The public origin THIS API is reachable at. Better Auth builds the Google
   * redirect URI from it, so if it is wrong you get `redirect_uri_mismatch` in
   * production and nowhere else. It must match the origin registered in the
   * Google Cloud Console exactly.
   */
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),

  // Where the browser is sent after verification / reset / OAuth. The frontend
  // passes the actual callbackURL per request; this is the origin we trust and
  // the fallback the docs tell it to use.
  FRONTEND_URL: z.url().default("http://localhost:3001"),

  // Comma separated. Defaults to FRONTEND_URL, which is the same-origin case.
  TRUSTED_ORIGINS: z.string().optional(),

  // Both or neither — enforced below. Absent means the Google provider is not
  // registered at all, so a fresh clone runs without any Google setup.
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  // Seconds. 7 days, refreshed once a day of use.
  AUTH_SESSION_EXPIRES_IN_S: z.coerce.number().int().positive().default(604_800),
  AUTH_SESSION_UPDATE_AGE_S: z.coerce.number().int().nonnegative().default(86_400),

  AUTH_REQUIRE_EMAIL_VERIFICATION: envBoolean.default(true),

  // Absent means "secure in production, plain in development", which is what
  // you want locally over http://.
  COOKIE_SECURE: envBoolean.optional(),
  COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
  COOKIE_DOMAIN: z.string().min(1).optional(),

  /* ---- Mail ------------------------------------------------------------- */

  /**
   * Which Mailer implementation gets built at boot (see lib/mailer.ts).
   *
   *   console  log the message, send nothing — the default, so a fresh clone
   *            runs and you copy the verification link out of your terminal
   *   resend   the real thing, requires RESEND_API_KEY
   *
   * "console" is refused in production below: with verification on, a
   * production deploy that only logs its emails is one where nobody can ever
   * finish signing up, and the symptom (silence) points nowhere near the cause.
   */
  MAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),

  // https://resend.com/api-keys. Only read when MAIL_PROVIDER=resend, and
  // required in that case — see the refine below.
  RESEND_API_KEY: z.string().min(1).optional(),

  EMAIL_FROM: z.email().default("no-reply@example.com"),

  /**
   * Optional, and worth setting: EMAIL_FROM is typically a no-reply address on
   * a domain you verified with the provider, and a user who hits reply on a
   * password-reset mail should reach a human rather than /dev/null.
   */
  EMAIL_REPLY_TO: z.email().optional(),

  // Branding. Appears in the auth emails and as Better Auth's appName. Safe to
  // change at any time: cookie names come from `cookiePrefix`, which is the
  // literal "better-auth" and does NOT derive from this — so renaming the app
  // does not sign everybody out.
  APP_NAME: z.string().min(1).max(60).default("Acme"),

  PG_HOST: z.string().min(1),
  PG_PORT: z.coerce.number().int().positive().default(5432),
  PG_USER: z.string().min(1),
  PG_PASSWORD: z.string(),
  PG_DATABASE: z.string().min(1),
  PG_POOL_MAX: z.coerce.number().int().positive().default(20),
  PG_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
  PG_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  /**
   * How long to keep serving after SIGTERM while /health/ready already reports
   * 503 — see the drain in server.ts.
   *
   * Absent means 5s in production and 0 locally, because the delay only buys
   * anything when a load balancer is polling readiness, and locally it just
   * makes Ctrl+C feel broken.
   */
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().nonnegative().optional(),

  /* ---- Error tracking --------------------------------------------------- */

  /**
   * Absent means Sentry is never initialised and nothing is sent anywhere — the
   * same "configure it or it does not exist" shape as the Google provider, so a
   * fresh clone runs with no account anywhere.
   */
  SENTRY_DSN: z.url().optional(),

  // 0 disables performance tracing and only sends errors, which is what the
  // free tier's quota is for. Raise to ~0.1 when you actually want traces.
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

  // Defaults to NODE_ENV. Set it when you run more than one deploy of the same
  // app (staging, production) and want them separated in the dashboard.
  SENTRY_ENVIRONMENT: z.string().min(1).optional(),

  /**
   * The build this process is running, reported to Sentry as the release so a
   * stack trace points at a commit. Wire it in your deploy:
   * `APP_VERSION=$(git rev-parse --short HEAD)`.
   */
  APP_VERSION: z.string().min(1).optional(),
});

/**
 * Cross-field rules. These are the combinations that are individually valid but
 * jointly broken — the kind that otherwise surface as a browser silently
 * dropping a cookie, or as an OAuth error only in production.
 */
const envSchemaWithRules = envSchema
  .refine((env) => Boolean(env.GOOGLE_CLIENT_ID) === Boolean(env.GOOGLE_CLIENT_SECRET), {
    path: ["GOOGLE_CLIENT_SECRET"],
    message:
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together, or both left unset",
  })
  .refine(
    // Browsers ignore SameSite=None unless Secure is also set, so this pair
    // produces a session that silently never persists. Fail at boot instead.
    (env) =>
      env.COOKIE_SAME_SITE !== "none" ||
      (env.COOKIE_SECURE ?? env.NODE_ENV === "production"),
    {
      path: ["COOKIE_SAME_SITE"],
      message: "COOKIE_SAME_SITE=none requires COOKIE_SECURE=true",
    }
  )
  .refine(
    /**
     * CORS is registered with `credentials: true`, so "*" here does not mean
     * the harmless public-API wildcard — @fastify/cors reflects whatever Origin
     * the request carried and tells the browser to send cookies with it. Any
     * site a signed-in user visits can then read authenticated responses.
     *
     * SameSite=lax blunts it today, but the split-origin deploy this
     * boilerplate documents (`COOKIE_SAME_SITE=none`) removes that mitigation
     * and turns it into a straightforward data-exfiltration hole. Convenient in
     * development, never correct in production — so it is a boot error there
     * and a permitted default everywhere else.
     */
    (env) =>
      env.NODE_ENV !== "production" ||
      !env.CORS_ORIGINS.split(",").some((origin) => origin.trim() === "*"),
    {
      path: ["CORS_ORIGINS"],
      message:
        "CORS_ORIGINS=* is refused in production: it reflects any origin while " +
        "credentials are enabled. List your frontend origins explicitly.",
    }
  )
  .refine((env) => env.MAIL_PROVIDER !== "resend" || Boolean(env.RESEND_API_KEY), {
    path: ["RESEND_API_KEY"],
    message: "RESEND_API_KEY is required when MAIL_PROVIDER=resend",
  })
  .refine(
    /**
     * The console mailer is a development affordance, not a degraded
     * production mode. Left on in production it does not fail — it succeeds,
     * logs the body, and every verification and password-reset link is
     * delivered to nobody. Refusing at boot turns a silent dead end into one
     * line at startup.
     */
    (env) => env.NODE_ENV !== "production" || env.MAIL_PROVIDER !== "console",
    {
      path: ["MAIL_PROVIDER"],
      message:
        "MAIL_PROVIDER=console is refused in production: it logs emails instead " +
        "of sending them, so verification and password-reset links never arrive. " +
        "Set MAIL_PROVIDER=resend (and RESEND_API_KEY).",
    }
  )
  .refine(
    /**
     * The one env var whose default the boilerplate cannot supply, and the one
     * most likely to be copied along with everything else. BETTER_AUTH_SECRET
     * signs session tokens: a production deploy running the committed dev
     * secret lets anyone who has read this repository mint a valid session for
     * any user, and nothing about it looks wrong at runtime.
     *
     * Exact matches, not a "change-me" substring search: a real generated
     * secret is random base64 and can contain any substring you care to look
     * for, so a substring rule would eventually reject a perfectly good key at
     * boot with a message the operator has no way to act on.
     */
    (env) =>
      env.NODE_ENV !== "production" || !PUBLISHED_SECRETS.has(env.BETTER_AUTH_SECRET),
    {
      path: ["BETTER_AUTH_SECRET"],
      message:
        "BETTER_AUTH_SECRET is still one of the values committed to this " +
        "repository, so it is public and anyone could forge a session. " +
        "Generate a real one with `npm run auth:secret`.",
    }
  )
  .refine(
    /**
     * Every verification link, reset link and OAuth redirect is built from
     * BETTER_AUTH_URL, and the browser lands on FRONTEND_URL afterwards. An
     * http:// value in production means credentials-adjacent links travel in
     * plaintext, secure cookies never attach, and Google answers with
     * redirect_uri_mismatch — three failures whose common cause is one
     * character of one env var. TRUSTED_ORIGINS only refuses http:// entries
     * rather than requiring https://, because a mobile app's custom scheme
     * (myapp://) is a legitimate trusted origin.
     */
    (env) => env.NODE_ENV !== "production" || env.BETTER_AUTH_URL.startsWith("https://"),
    {
      path: ["BETTER_AUTH_URL"],
      message: "BETTER_AUTH_URL must be an https:// origin in production",
    }
  )
  .refine(
    (env) => env.NODE_ENV !== "production" || env.FRONTEND_URL.startsWith("https://"),
    {
      path: ["FRONTEND_URL"],
      message: "FRONTEND_URL must be an https:// origin in production",
    }
  )
  .refine(
    (env) =>
      env.NODE_ENV !== "production" ||
      !(env.TRUSTED_ORIGINS ?? "")
        .split(",")
        .some((origin) => origin.trim().startsWith("http://")),
    {
      path: ["TRUSTED_ORIGINS"],
      message:
        "TRUSTED_ORIGINS must not contain http:// origins in production — " +
        "callbackURLs redirected to them would carry auth results over plaintext",
    }
  )
  .refine(
    /**
     * A production deploy is behind a proxy essentially always, and if
     * TRUST_PROXY is left at its safe default there, every request appears to
     * come from the load balancer: one rate-limit bucket for the entire
     * internet, and useless client IPs in the logs. Failing loudly beats
     * discovering it from a credential-stuffing run that never got limited.
     */
    (env) => env.NODE_ENV !== "production" || env.TRUST_PROXY !== false,
    {
      path: ["TRUST_PROXY"],
      message:
        "TRUST_PROXY must be set in production — the number of proxy hops in " +
        "front of this process (e.g. 1), or the proxy's address/CIDR. Use " +
        "TRUST_PROXY=false only if the process is exposed directly.",
    }
  );

const parsed = envSchemaWithRules.safeParse(process.env);

if (!parsed.success) {
  // Written straight to stderr: the logger itself depends on this config, so
  // it does not exist yet at this point in the boot sequence.
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");

  process.stderr.write(`Invalid environment configuration:\n${details}\n`);
  process.exit(1);
}

const env = parsed.data;
const isProduction = env.NODE_ENV === "production";

export const config = {
  env: env.NODE_ENV,
  isProduction,
  isDevelopment: env.NODE_ENV === "development",
  isTest: env.NODE_ENV === "test",

  server: {
    port: env.PORT,
    host: env.HOST,
    bodyLimit: env.BODY_LIMIT_BYTES,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    // Only useful when something is polling /health/ready, which locally
    // nothing is — so it costs a fresh clone nothing and is on by default
    // exactly where it matters.
    shutdownDrainMs: env.SHUTDOWN_DRAIN_MS ?? (isProduction ? 5_000 : 0),
    trustProxy: env.TRUST_PROXY,
  },

  logLevel: env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),

  // "*" means reflect any origin; anything else is an explicit allow-list.
  corsOrigins: env.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
  },

  auth: {
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: env.BETTER_AUTH_URL,

    /**
     * Not an env var on purpose. This string appears in three places that must
     * agree: the Fastify prefix in app.ts, Better Auth's own router, and the
     * redirect URI registered with Google. Making it configurable would let
     * them drift, and the failure mode is an OAuth error in production only.
     */
    basePath: "/api/auth",

    frontendUrl: env.FRONTEND_URL,

    /**
     * Every callbackURL / errorCallbackURL a client asks to be redirected to is
     * checked against this list, which is what stops the auth endpoints from
     * being an open redirect. Same-origin deploys need only the frontend.
     */
    trustedOrigins: (env.TRUSTED_ORIGINS ?? env.FRONTEND_URL)
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),

    session: {
      expiresIn: env.AUTH_SESSION_EXPIRES_IN_S,
      updateAge: env.AUTH_SESSION_UPDATE_AGE_S,
    },

    requireEmailVerification: env.AUTH_REQUIRE_EMAIL_VERIFICATION,

    // `null`, not `undefined` — an absent provider is a real state the factory
    // branches on, and null makes that check explicit at the call site.
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : null,

    cookie: {
      secure: env.COOKIE_SECURE ?? isProduction,
      sameSite: env.COOKIE_SAME_SITE,
      // Spread rather than `undefined`: `exactOptionalPropertyTypes` treats an
      // absent key and a key set to undefined as different types.
      ...(env.COOKIE_DOMAIN === undefined ? {} : { domain: env.COOKIE_DOMAIN }),
    },

    appName: env.APP_NAME,
  },

  mail: {
    provider: env.MAIL_PROVIDER,
    // null rather than undefined: "no key configured" is a state the mailer
    // factory branches on, and null makes that check explicit at the call site.
    resendApiKey: env.RESEND_API_KEY ?? null,
    from: env.EMAIL_FROM,
    ...(env.EMAIL_REPLY_TO === undefined ? {} : { replyTo: env.EMAIL_REPLY_TO }),
  },

  sentry: {
    // null, not undefined: "no DSN configured" is a state instrument.ts
    // branches on, and null makes that check explicit at the call site.
    dsn: env.SENTRY_DSN ?? null,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    ...(env.APP_VERSION === undefined ? {} : { release: env.APP_VERSION }),
  },

  db: {
    host: env.PG_HOST,
    port: env.PG_PORT,
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    database: env.PG_DATABASE,
    max: env.PG_POOL_MAX,
    idleTimeoutMillis: env.PG_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.PG_CONNECT_TIMEOUT_MS,
  },
} as const;

export type Config = typeof config;
