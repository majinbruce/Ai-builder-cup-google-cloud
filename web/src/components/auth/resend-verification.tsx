"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";

/**
 * "Send it again", for the case the first email never arrived.
 *
 * The address is a prop when we know it (straight after sign-up) and an input
 * when we do not (someone arriving at this page from a bookmark). The API rate
 * limits this endpoint to 3 a minute, and a 429 is reported as such rather than
 * as a generic failure — see authErrorMessage.
 */
export function ResendVerification({ email: initialEmail = "" }: { email?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [pending, setPending] = useState(false);

  const onResend = async () => {
    if (!email) return;

    setPending(true);

    const { error } = await authClient.sendVerificationEmail({
      email,
      callbackURL: "/verify-email/callback",
    });

    setPending(false);

    if (error) {
      toast.error(authErrorMessage(error));
      return;
    }

    toast.success("Sent. Check your inbox.");
  };

  return (
    <FieldGroup>
      {initialEmail ? null : (
        <Field>
          <FieldLabel htmlFor="resend-email">Email</FieldLabel>
          <Input
            id="resend-email"
            type="email"
            autoComplete="email"
            placeholder="m@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
      )}

      <Field>
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={pending || !email}
          onClick={onResend}
        >
          {pending ? "Sending…" : "Send the email again"}
        </Button>
      </Field>
    </FieldGroup>
  );
}
