"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FieldSeparator } from "@/components/ui/field";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";
import { useSiteConfig } from "@/components/providers";
import type { SocialProvider } from "@/lib/site-config";

/**
 * The social sign-in row, rendered from what the API said it supports — never
 * from a flag in this app's environment. `siteConfig.auth.social` comes from
 * `GET /api/auth/providers`; see lib/site-config.server.ts for why.
 *
 * An empty list renders nothing at all, separator included, so a deployment
 * with no OAuth credentials gets a clean email-only screen rather than a button
 * that fails on click.
 */
const PROVIDERS: Record<
  SocialProvider,
  { label: string; mark: () => React.ReactElement }
> = {
  google: { label: "Continue with Google", mark: GoogleMark },
};

export function SocialButtons({ callbackURL }: { callbackURL: string }) {
  const { auth } = useSiteConfig();
  const [pending, setPending] = useState<SocialProvider | null>(null);

  if (auth.social.length === 0) return null;

  const onSignIn = async (provider: SocialProvider) => {
    setPending(provider);

    const { error } = await authClient.signIn.social({
      provider,
      // Relative, and checked against the API's trustedOrigins on the way
      // through. An absolute URL supplied by the client is exactly what Better
      // Auth's origin check exists to reject.
      callbackURL,
      errorCallbackURL: "/sign-in",
    });

    // Only reached when the redirect did NOT happen — on success the browser
    // has already left for the provider.
    if (error) {
      setPending(null);
      toast.error(authErrorMessage(error));
    }
  };

  return (
    <>
      {auth.social.map((provider) => {
        const { label, mark: Mark } = PROVIDERS[provider];

        return (
          <Button
            key={provider}
            type="button"
            variant="outline"
            size="lg"
            disabled={pending !== null}
            onClick={() => onSignIn(provider)}
          >
            <Mark />
            {label}
          </Button>
        );
      })}

      {/* Only meaningful when there is also an email form below it. */}
      {auth.emailAndPassword ? <FieldSeparator>Or</FieldSeparator> : null}
    </>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.94-2.92l-3.88-3c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.09A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.29 14.28a7.2 7.2 0 0 1 0-4.56V6.63H1.28a12 12 0 0 0 0 10.74l4.01-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.43-3.43C17.95 1.18 15.23 0 12 0A12 12 0 0 0 1.28 6.63l4.01 3.09C6.23 6.88 8.88 4.77 12 4.77Z"
      />
    </svg>
  );
}
