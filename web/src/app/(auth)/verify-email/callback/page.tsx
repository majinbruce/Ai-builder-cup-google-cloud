import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ResendVerification } from "@/components/auth/resend-verification";

export const metadata: Metadata = { title: "Verifying your email" };

/**
 * Where the link in the verification email finally lands.
 *
 * Better Auth validates the token on its own endpoint and then redirects here:
 * with `?error=<CODE>` if the token was expired or already used, and with no
 * error at all on success — at which point `autoSignInAfterVerification` has
 * already issued a session, so there is nothing left to do but move on.
 *
 * This page exists so that failure has somewhere to be SHOWN. Pointing the
 * callback straight at /dashboard works for the happy path and silently drops
 * the error code on the unhappy one.
 */
export default async function VerifyEmailCallbackPage({
  searchParams,
}: PageProps<"/verify-email/callback">) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;

  if (error === null) {
    redirect("/dashboard");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>That link did not work</CardTitle>
        <CardDescription>
          Verification links expire and can only be used once. Request a fresh one below.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <ResendVerification />
      </CardContent>
    </Card>
  );
}
