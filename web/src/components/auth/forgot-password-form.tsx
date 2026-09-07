"use client";

import Link from "next/link";
import { useState } from "react";
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
import { authErrorMessage } from "@/lib/auth-errors";
import { forgotPasswordSchema, type ForgotPasswordValues } from "@/lib/validation";

/**
 * The success state says "if an account exists" and never "we sent it", on
 * purpose. Confirming which addresses have accounts turns this form into an
 * account-enumeration oracle; the API answers identically either way, and this
 * copy is the other half of that.
 */
export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);

  const form = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form;

  const onSubmit = async (values: ForgotPasswordValues) => {
    const { error } = await authClient.requestPasswordReset({
      email: values.email,
      // Better Auth emails a link to its own endpoint; following it validates
      // the token and then redirects HERE with `?token=` (or
      // `?error=INVALID_TOKEN`). Relative, so it is checked against the API's
      // trustedOrigins.
      redirectTo: "/reset-password",
    });

    if (error) {
      toast.error(authErrorMessage(error));
      return;
    }

    setSent(true);
  };

  if (sent) {
    return (
      <FieldGroup>
        <div className="grid gap-2 text-sm">
          <p className="font-medium">Check your email</p>
          <p className="text-muted-foreground">
            If an account exists for that address, a password reset link is on its way.
            The link expires in one hour.
          </p>
        </div>
        <Button asChild variant="outline" size="lg">
          <Link href="/sign-in">Back to sign in</Link>
        </Button>
      </FieldGroup>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
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

        <Field>
          <Button type="submit" size="lg" disabled={isSubmitting}>
            {isSubmitting ? "Sending…" : "Send reset link"}
          </Button>
          <FieldDescription className="text-center">
            <Link href="/sign-in" className="underline underline-offset-4">
              Back to sign in
            </Link>
          </FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  );
}
