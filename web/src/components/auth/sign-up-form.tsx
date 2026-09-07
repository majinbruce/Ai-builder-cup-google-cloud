"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { signUpSchema, type SignUpValues } from "@/lib/validation";
import { useSiteConfig } from "@/components/providers";
import { SocialButtons } from "@/components/auth/social-buttons";

/**
 * Sign-up branches on one capability, and it is the only screen that does:
 *
 *   requireEmailVerification true  — the API refuses sign-in until the address
 *     is verified, so land on /verify-email and say so.
 *   false — the API's `autoSignIn` has already issued a session, so go straight
 *     into the app.
 *
 * The value comes from the API (`GET /api/auth/providers`), not from this app's
 * environment, so it cannot disagree with the server that enforces it.
 */
export function SignUpForm() {
  const router = useRouter();
  const { auth } = useSiteConfig();

  const form = useForm<SignUpValues>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
  });

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = form;

  const onSubmit = async (values: SignUpValues) => {
    const { error } = await authClient.signUp.email({
      name: values.name,
      email: values.email,
      password: values.password,
      // Where the link in the verification email lands once it is followed.
      // Relative: the API resolves it against BETTER_AUTH_URL and rejects
      // anything outside its trustedOrigins. It points at the callback page
      // rather than at /dashboard so an expired token has somewhere to be
      // reported — see (auth)/verify-email/callback.
      callbackURL: "/verify-email/callback",
    });

    if (error) {
      if (!applyAuthError(error, setError, ["email", "password"])) {
        toast.error(authErrorMessage(error));
      }
      return;
    }

    if (auth.requireEmailVerification) {
      router.push(`/verify-email?email=${encodeURIComponent(values.email)}`);
      return;
    }

    router.refresh();
    router.push("/dashboard");
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <SocialButtons callbackURL="/dashboard" />

        <Field data-invalid={errors.name !== undefined}>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input
            id="name"
            autoComplete="name"
            aria-invalid={errors.name !== undefined}
            {...register("name")}
          />
          <FieldError errors={[errors.name]} />
        </Field>

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
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.password !== undefined}
            {...register("password")}
          />
          {/* The API also rejects common passwords, sequential runs and
              anything containing the email or the app name — those come back as
              WEAK_PASSWORD and land on this field. */}
          <FieldDescription>At least 8 characters.</FieldDescription>
          <FieldError errors={[errors.password]} />
        </Field>

        <Field data-invalid={errors.confirmPassword !== undefined}>
          <FieldLabel htmlFor="confirmPassword">Confirm password</FieldLabel>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.confirmPassword !== undefined}
            {...register("confirmPassword")}
          />
          <FieldError errors={[errors.confirmPassword]} />
        </Field>

        <Field>
          <Button type="submit" size="lg" disabled={isSubmitting}>
            {isSubmitting ? "Creating account…" : "Create account"}
          </Button>
          <FieldDescription className="text-center">
            Already have an account?{" "}
            <Link href="/sign-in" className="underline underline-offset-4">
              Sign in
            </Link>
          </FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  );
}
