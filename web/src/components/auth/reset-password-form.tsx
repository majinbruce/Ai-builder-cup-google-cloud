"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { authClient } from "@/lib/auth-client";
import { applyAuthError, authErrorMessage } from "@/lib/auth-errors";
import { resetPasswordSchema, type ResetPasswordValues } from "@/lib/validation";

/**
 * Reached only from the email link, which arrives as
 * `/reset-password?token=…` — or `?error=INVALID_TOKEN` when Better Auth has
 * already rejected it, which is the case worth rendering properly rather than
 * as an empty form that fails on submit.
 *
 * The API revokes every other session on a successful reset
 * (`revokeSessionsOnPasswordReset`), so this deliberately sends the user to
 * sign-in rather than pretending they are still authenticated.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const token = searchParams.get("token");
  const linkError = searchParams.get("error");

  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = form;

  if (linkError !== null || token === null) {
    return (
      <FieldGroup>
        <div className="grid gap-2 text-sm">
          <p className="font-medium text-destructive">This link is no longer valid</p>
          <p className="text-muted-foreground">
            Reset links expire after an hour and can only be used once.
          </p>
        </div>
        <Button asChild size="lg">
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </FieldGroup>
    );
  }

  const onSubmit = async (values: ResetPasswordValues) => {
    const { error } = await authClient.resetPassword({
      newPassword: values.password,
      token,
    });

    if (error) {
      if (!applyAuthError(error, setError, ["password"])) {
        toast.error(authErrorMessage(error));
      }
      return;
    }

    toast.success("Password updated. Sign in with your new password.");
    router.push("/sign-in");
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Field data-invalid={errors.password !== undefined}>
          <FieldLabel htmlFor="password">New password</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.password !== undefined}
            {...register("password")}
          />
          <FieldError errors={[errors.password]} />
        </Field>

        <Field data-invalid={errors.confirmPassword !== undefined}>
          <FieldLabel htmlFor="confirmPassword">Confirm new password</FieldLabel>
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
            {isSubmitting ? "Updating…" : "Update password"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
