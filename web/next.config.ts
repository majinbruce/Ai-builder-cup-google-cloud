import type { NextConfig } from "next";

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
   * `src/proxy.ts` forwards `/api/*` to `API_ORIGIN`, at runtime, in development
   * and production alike. There is deliberately no `rewrites()` here: it is
   * evaluated at BUILD time, so it could only forward to an address baked into
   * the image, and on Cloud Run the API is a separate service whose URL is a
   * deploy-time fact.
   */
  experimental: {
    /**
     * Next buffers each request body for proxy.ts and, past this limit,
     * forwards a TRUNCATED body without failing (see the proxyClientMaxBodySize
     * page in Next's docs). The default is 10 MB; the API accepts uploads up to
     * MAX_UPLOAD_BYTES (100 MiB) plus multipart framing. Measured 2026-09-11 at
     * the default: a 26 MiB upload that the API should have refused with 413
     * came back 500, with Next logging "Only the first 10MB will be available".
     * So this sits just above the API's cap, and the API's own 413 is what an
     * oversized upload gets.
     *
     * In production a browser upload goes straight to GCS on a signed URL and
     * never passes through here; what does is the local backend's PUT route
     * (no GCS_BUCKET), where a 40 MB lecture under the old 27 MB limit arrived
     * cut off and was ingested as a shorter clip or refused as "not audio".
     */
    proxyClientMaxBodySize: "101mb",
  },
};

export default nextConfig;
