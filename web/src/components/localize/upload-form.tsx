"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { FileAudio, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { ApiError } from "@/lib/api/envelope";
import {
  ACCEPTED_UPLOAD_TYPES,
  MAX_CLIP_SECONDS,
  MAX_UPLOAD_BYTES,
  createJob,
} from "@/lib/api/localize";
import { applyFieldErrors } from "@/lib/auth-errors";
import { cn } from "@/lib/utils";
import { uploadSchema, type UploadValues } from "@/lib/validation";

const formatSize = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const formatDuration = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

/**
 * The file's duration as the browser decodes it, or null when it cannot (an
 * unusual codec). Advisory only: the API measures again with ffprobe and its
 * answer is the one that counts.
 */
function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const media = document.createElement(
      file.type.startsWith("video/") ? "video" : "audio"
    );
    media.preload = "metadata";
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    media.onloadedmetadata = () =>
      done(Number.isFinite(media.duration) ? media.duration : null);
    media.onerror = () => done(null);
    media.src = url;
  });
}

/**
 * Upload a clip, then go straight to its job page, which polls.
 *
 * The browser checks size, type and — where it can decode the file — length,
 * so a user is not made to upload 40 MB or a ten-minute lecture to be told no;
 * the API checks all three again plus whether the file is audio at all, and
 * its `details[]` land under the same field through applyFieldErrors.
 */
export function UploadForm() {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  // 0-1 while the bytes go up; null before and after. A 100 MB lecture takes
  // long enough that a button reading "Uploading" alone looks like a hang.
  const [progress, setProgress] = useState<number | null>(null);
  const [picked, setPicked] = useState<{ file: File; durationSec: number | null } | null>(
    null
  );

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<UploadValues>({ resolver: zodResolver(uploadSchema) });

  const inspect = async (files: FileList | null) => {
    const file = files?.[0];
    if (file === undefined) {
      setPicked(null);
      return;
    }
    clearErrors("file");
    const durationSec = await probeDuration(file);
    setPicked({ file, durationSec });
    if (durationSec !== null && durationSec > MAX_CLIP_SECONDS) {
      setError("file", {
        message: `This clip is ${formatDuration(durationSec)} long; the limit is ${MAX_CLIP_SECONDS / 60} minutes. Trim it and try again.`,
      });
    }
  };

  const field = register("file", {
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      void inspect(event.target.files),
  });

  const onDrop = (event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const { files } = event.dataTransfer;
    if (files.length === 0) return;
    setValue("file", files, { shouldValidate: true });
    void inspect(files);
  };

  const tooLong =
    picked?.durationSec !== null &&
    picked?.durationSec !== undefined &&
    picked.durationSec > MAX_CLIP_SECONDS;

  const onSubmit = async (values: UploadValues) => {
    const file = values.file[0];
    if (file === undefined || tooLong) return;

    try {
      setProgress(0);
      const job = await createJob(file, setProgress);
      router.push(`/localize/${job.id}`);
    } catch (error) {
      setProgress(null);
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
          <FieldLabel htmlFor="file" className="sr-only">
            English lecture clip
          </FieldLabel>
          <label
            htmlFor="file"
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors hover:border-primary/50 hover:bg-primary/5 has-[:focus-visible]:border-primary has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
              dragging && "border-primary bg-primary/5",
              errors.file !== undefined && "border-destructive/60"
            )}
          >
            {picked === null ? (
              <>
                <Upload className="size-8 text-primary" aria-hidden />
                <span className="grid gap-1">
                  <span className="font-medium">
                    Drop an English lecture here, or choose a file
                  </span>
                  <span className="text-sm text-muted-foreground">
                    Audio or mp4 video, up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB and{" "}
                    {MAX_CLIP_SECONDS / 60} minutes
                  </span>
                </span>
              </>
            ) : (
              <>
                <FileAudio className="size-8 text-primary" aria-hidden />
                <span className="grid gap-1">
                  <span className="font-medium break-all">{picked.file.name}</span>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {formatSize(picked.file.size)}
                    {picked.durationSec === null
                      ? ""
                      : `, ${formatDuration(picked.durationSec)} long`}
                    . Choose a different file
                  </span>
                </span>
              </>
            )}
            <input
              id="file"
              type="file"
              accept={ACCEPTED_UPLOAD_TYPES}
              aria-invalid={errors.file !== undefined}
              className="sr-only"
              {...field}
            />
          </label>
          <FieldDescription>
            A one-minute clip takes about four minutes: Gemini listens, plans, re-teaches
            each segment, critiques itself and then speaks. Lectures with definitions,
            examples and a clear teacher voice show the most.
          </FieldDescription>
          <FieldError errors={[errors.file]} />
        </Field>
        <Field orientation="horizontal">
          <Button type="submit" size="lg" disabled={isSubmitting || tooLong}>
            {!isSubmitting
              ? "Localize to Hindi"
              : progress !== null && progress < 1
                ? `Uploading ${Math.round(progress * 100)}%`
                : "Starting the job"}
          </Button>
          {isSubmitting && progress !== null ? (
            <progress
              value={progress}
              max={1}
              aria-label="Upload progress"
              className="h-2 w-full max-w-48 accent-primary"
            />
          ) : null}
        </Field>
      </FieldGroup>
    </form>
  );
}
