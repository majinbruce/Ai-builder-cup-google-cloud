import type { Metadata } from "next";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ResendVerification } from "@/components/auth/resend-verification";

export const metadata: Metadata = { title: "Verify your email" };

/**
 * Where sign-up lands when AUTH_REQUIRE_EMAIL_VERIFICATION is on.
 *
 * `searchParams` is a PROMISE in Next.js 15+. Awaiting it is not optional — it
 * is what tells the framework this render is dynamic.
 */
export default async function VerifyEmailPage({
  searchParams,
}: PageProps<"/verify-email">) {
  const params = await searchParams;
  const email = typeof params.email === "string" ? params.email : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Check your email</CardTitle>
        <CardDescription>
          {email
            ? `We sent a verification link to ${email}. Follow it to finish setting up your account.`
            : "Follow the verification link we emailed you to finish setting up your account."}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <ResendVerification {...(email === undefined ? {} : { email })} />
      </CardContent>

      <CardFooter className="justify-center text-sm text-muted-foreground">
        <Link href="/sign-in" className="underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </CardFooter>
    </Card>
  );
}
