import type { NextConfig } from "next";

/**
 * Where the Fastify API lives, as seen from the machine running `next dev`.
 * Only read here, and only in development — see the rewrite below.
 */
const DEV_API_ORIGIN = process.env.API_ORIGIN ?? "http://127.0.0.1:3000";

const nextConfig: NextConfig = {
  /**
   * This app lives beside the API in one repository, so there are two
   * package-lock.json files above it. Turbopack infers the workspace root from
   * the outermost lockfile it finds and would trace the API's node_modules into
   * this build; pinning it here keeps the two independent.
   */
  turbopack: { root: import.meta.dirname },

  /**
   * Builds `.next/standalone/server.js` with only the node_modules the app
   * actually imports. It is what the Dockerfile's runtime stage copies, and the
   * reason the production image is ~200MB instead of ~1GB.
   */
  output: "standalone",

  // Nothing gains from advertising the framework version.
  poweredByHeader: false,

  reactStrictMode: true,

  /**
   * ========================================================================
   * The browser only ever talks to its own origin.
   * ========================================================================
   *
   * Every request the client makes is to a RELATIVE path — `/api/auth/...`,
   * `/api/v1/...`. That is a deliberate architectural choice, not a shortcut:
   *
   *   - No CORS. The API's CORS_ORIGINS never has to know about the browser.
   *   - No cross-site cookies. The session cookie is first-party, so it
   *     survives SameSite=Lax, Safari ITP and every tracking-prevention
   *     default that breaks a cookie on api.example.com read from example.com.
   *   - BETTER_AUTH_URL is the *public web* origin, so Google's redirect_uri,
   *     the verification link and the reset link all land on this app.
   *
   * Who actually forwards `/api/*` to Fastify differs by environment:
   *
   *   development — this rewrite, because `next dev` (:3001) and the API
   *                 (:3000) are two processes on two ports.
   *   production  — Caddy, which routes `/api/*` to the api container and
   *                 everything else here. See deploy/host/caddy/Caddyfile.
   *
   * The split matters: `rewrites()` is evaluated at BUILD time and baked into
   * the routes manifest, so an API_ORIGIN baked into the image could not be
   * changed by an env var at deploy time. Keeping the rewrite development-only
   * means the production image has no build-time knowledge of the API's
   * address at all — server components read API_ORIGIN at runtime instead.
   */
  async rewrites() {
    if (process.env.NODE_ENV === "production") return [];

    return [
      {
        source: "/api/:path*",
        destination: `${DEV_API_ORIGIN}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
