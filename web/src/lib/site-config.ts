/**
 * The slice of configuration the BROWSER is allowed to know.
 *
 * Deliberately a plain serialisable object with no import of `env.ts`: this
 * module is imported by client components, and `env.ts` is `server-only`. The
 * value is built once in the root layout (a server component) and pushed down
 * through `SiteConfigProvider`, which is how a runtime-configurable container
 * ships client-visible config without `NEXT_PUBLIC_` build-time inlining.
 *
 * Anything added here is PUBLIC. It ends up in the HTML payload; treat it the
 * way you would treat a value in a <meta> tag.
 */
export interface SiteConfig {
  appName: string;
  auth: AuthCapabilities;
}

/**
 * What the API says it can authenticate with — NOT what this app's environment
 * claims. See `site-config.server.ts`.
 */
export interface AuthCapabilities {
  /** Provider ids to render social buttons for, in the order given. */
  social: SocialProvider[];
  emailAndPassword: boolean;
  requireEmailVerification: boolean;
}

export type SocialProvider = "google";
