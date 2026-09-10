"use client";

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
import { ApiError } from "@/lib/api/envelope";
import { ACCEPTED_UPLOAD_TYPES, MAX_CLIP_SECONDS, createJob } from "@/lib/api/localize";
import { applyFieldErrors } from "@/lib/auth-errors";
import { uploadSchema, type UploadValues } from "@/lib/validation";

/**
 * Upload a clip, then go straight to its job page, which polls.
 *
 * The browser checks size and type so a user is not made to upload 40 MB to be
 * told no; the API checks both again plus what only it can — the decoded
 * duration and whether the file is audio at all — and its `details[]` land
 * under the same field through applyFieldErrors.
 */
export function UploadForm() {
  const router = useRouter();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<UploadValues>({ resolver: zodResolver(uploadSchema) });

  const onSubmit = async (values: UploadValues) => {
    const file = values.file[0];
    if (file === undefined) return;

    try {
      const job = await createJob(file);
      router.push(`/localize/${job.id}`);
    } catch (error) {
      if (applyFieldErrors(error, setError, ["file"])) return;

      if (error instanceof ApiError && (error.status === 413 || error.status === 415)) {
        setError("file", { message: error.message });
        return;
      }

      toast.error(error instanceof ApiError ? error.message : "Upload failed");
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Field data-invalid={errors.file !== undefined}>
          <FieldLabel htmlFor="file">English lecture clip</FieldLabel>
          <Input
            id="file"
            type="file"
            accept={ACCEPTED_UPLOAD_TYPES}
            aria-invalid={errors.file !== undefined}
            {...register("file")}
          />
          <FieldDescription>
            Audio or mp4, up to 25 MB and {MAX_CLIP_SECONDS} seconds. A 60-second clip
            takes three to four minutes: the pipeline listens, writes a brief, re-teaches
            each segment, critiques itself blind and then speaks.
          </FieldDescription>
          <FieldError errors={[errors.file]} />
        </Field>
        <Field>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Uploading…" : "Localize to Hindi"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
