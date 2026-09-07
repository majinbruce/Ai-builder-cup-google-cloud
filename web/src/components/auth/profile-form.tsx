"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { updateOwnProfile } from "@/lib/api/users";
import { ApiError } from "@/lib/api/envelope";
import { applyFieldErrors } from "@/lib/auth-errors";
import { profileSchema, type ProfileValues } from "@/lib/validation";

/**
 * The worked example of calling `/api/v1/*` from the browser: a resource
 * function from `lib/api/users.ts`, a thrown `ApiError` on failure, and the
 * envelope's `details[]` turned into inline field messages.
 *
 * Note the difference from the auth forms: this THROWS. Better Auth's client
 * resolves with `{ error }`; everything else in this codebase raises. The two
 * conventions live side by side because the SDK owns one of them.
 */
export function ProfileForm({ name }: { name: string }) {
  const router = useRouter();

  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { name },
  });

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = form;

  const onSubmit = async (values: ProfileValues) => {
    try {
      await updateOwnProfile({ name: values.name });

      toast.success("Profile updated");
      // The server components showing this name were rendered before the
      // change; re-render them rather than duplicating the value in state.
      router.refresh();
    } catch (error) {
      if (applyFieldErrors(error, setError, ["name"])) return;

      toast.error(
        error instanceof ApiError ? error.message : "Could not save your profile"
      );
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
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

        <Field orientation="horizontal">
          <Button type="submit" disabled={isSubmitting || !isDirty}>
            {isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
