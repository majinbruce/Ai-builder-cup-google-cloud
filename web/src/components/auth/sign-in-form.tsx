"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { authClient } from "@/lib/auth-client";
import { applyAuthError, authErrorMessage } from "@/lib/auth-errors";
import { safeRedirect } from "@/lib/safe-redirect";
import { signInSchema, type SignInValues } from "@/lib/validation";
import { SocialButtons } from "@/components/auth/social-buttons";

/**
 * The reference form for this codebase. Every other one follows its shape:
 *
 *   shadcn's <FieldGroup>/<Field> markup — the same primitives its official
 *   login blocks are built from, so `npx shadcn add login-04` and this file
 *   agree on structure
 *   + react-hook-form and a zod schema from lib/validation.ts for state and
 *   client-side validation, which the static blocks do not carry
 *   + applyAuthError / applyFieldErrors to put a SERVER failure on the field
 *   that caused it
 *
 * `authClient.signIn.email` RESOLVES on failure — the SDK returns
 * `{ data, error }` and does not throw. Wrapping it in try/catch and expecting
 * the catch to fire is the most common way a sign-in form silently reports
 * success.
 */
export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Where the proxy sent them from, sanitised — see lib/safe-redirect.ts.
  const next = safeRedirect(searchParams.get("next"), "/dashboard");

  const form = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "", rememberMe: true },
  });

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = form;

  const onSubmit = async (values: SignInValues) => {
    const { error } = await authClient.signIn.email({
      email: values.email,
      password: values.password,
      rememberMe: values.rememberMe,
    });

    if (error) {
      if (!applyAuthError(error, setError, ["email", "password"])) {
        toast.error(authErrorMessage(error));
      }
      return;
    }

    /**
     * `refresh()` before `push()`, and both are needed.
     *
     * The session now exists as a cookie, but every server component already
     * rendered in this browser was rendered without it — including the header.
     * `refresh()` re-renders them against the new cookie; `push()` then
     * navigates. Skipping the refresh is why a freshly signed-in user sees a
     * "Sign in" button until they hard-reload.
     */
    router.refresh();
    router.push(next);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <SocialButtons callbackURL={next} />

        <Field data-invalid={errors.email !== undefined}>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="m@example.com"
            aria-invalid={errors.email !== undefined}
            {...register("email")}
          />
          <FieldError errors={[errors.email]} />
        </Field>

        <Field data-invalid={errors.password !== undefined}>
          <div className="flex items-center">
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Link
              href="/forgot-password"
              className="ml-auto text-sm underline-offset-4 hover:underline"
            >
              Forgot your password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={errors.password !== undefined}
            {...register("password")}
          />
          <FieldError errors={[errors.password]} />
        </Field>

        <Field>
          <Button type="submit" size="lg" disabled={isSubmitting}>
            {isSubmitting ? "Signing in…" : "Sign in"}
          </Button>
          <FieldDescription className="text-center">
            Don&apos;t have an account?{" "}
            <Link href="/sign-up" className="underline underline-offset-4">
              Sign up
            </Link>
          </FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  );
}
