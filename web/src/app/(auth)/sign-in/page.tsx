import type { Metadata } from "next";
import { Suspense } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SignInForm } from "@/components/auth/sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Login to your account</CardTitle>
        <CardDescription>
          Enter your email below to login to your account.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {/*
          The form reads `?next=` with useSearchParams, which suspends. Without
          this boundary the whole route opts out of static rendering and the
          build warns about it — the boundary is the fix, not a workaround.
        */}
        <Suspense fallback={<Skeleton className="h-72 w-full" />}>
          <SignInForm />
        </Suspense>
      </CardContent>
    </Card>
  );
}
