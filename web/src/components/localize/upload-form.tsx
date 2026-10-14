"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { FileAudio, Upload } from "lucide-react";
import { toast } from "sonner";
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
const formatDuration = (sec: number) => {
  // Rounded BEFORE splitting, or 119.6 s prints as "1:60".
  const whole = Math.round(sec);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

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

/** One file as the FileList a file input would hold. */
function asFileList(file: File): FileList {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  return transfer.files;
}

/**
 * Upload a clip, then go straight to its job page, which polls.
 *
 * The browser checks size, type and — where it can decode the file — length,
 * so a user is not made to upload 40 MB or a ten-minute lecture to be told no;
 * the API checks all three again plus whether the file is audio at all, and
 * its `details[]` land under the same field through applyFieldErrors.
 */
export function UploadForm({ initialFile = null }: { initialFile?: File | null }) {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  // 0-1 while the bytes go up; null before and after. A 100 MB lecture takes
  // long enough that a button reading "Uploading" alone looks like a hang.
  const [progress, setProgress] = useState<number | null>(null);
  const [picked, setPicked] = useState<{ file: File; durationSec: number | null } | null>(
    initialFile === null ? null : { file: initialFile, durationSec: null }
  );

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<UploadValues>({
    resolver: zodResolver(uploadSchema),
    ...(initialFile === null ? {} : { defaultValues: { file: asFileList(initialFile) } }),
  });

  const inspect = async (files: FileList | null) => {
    const file = files?.[0];
    if (file === undefined) {
      setPicked(null);
      return;
    }
    clearErrors("file");
    setPicked({ file, durationSec: null });
    const durationSec = await probeDuration(file);
    // Only if it is still the picked file: a slow probe of an earlier pick
    // must not overwrite the newer file's card.
    setPicked((current) => (current?.file === file ? { file, durationSec } : current));
  };

  const field = register("file", {
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      void inspect(event.target.files),
  });

  // A file dropped on the library's dropzone arrives already chosen; only its
  // length is still to be read.
  useEffect(() => {
    if (initialFile === null) return;
    void probeDuration(initialFile).then((durationSec) =>
      setPicked((current) =>
        current?.file === initialFile ? { file: initialFile, durationSec } : current
      )
    );
  }, [initialFile]);

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

  useEffect(() => {
    if (tooLong && picked !== null && picked.durationSec !== null) {
      setError("file", {
        message: `This clip is ${formatDuration(picked.durationSec)} long; the limit is ${MAX_CLIP_SECONDS / 60} minutes. Trim it and try again.`,
      });
    }
  }, [tooLong, picked, setError]);

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
              "flex min-h-[min(220px,26vh)] cursor-pointer flex-col items-center justify-center gap-3 border border-dashed border-cream/35 p-6 text-center transition-colors hover:border-cream has-[:focus-visible]:border-cream has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-lime",
              (dragging || picked !== null) && "border-cream",
              dragging && "bg-cream/6",
              errors.file !== undefined && "border-destructive"
            )}
          >
            {picked === null ? (
              <>
                <span className="flex size-[52px] items-center justify-center border border-cream">
                  <Upload className="size-5" strokeWidth={1.3} aria-hidden />
                </span>
                <span className="grid gap-1">
                  <span className="text-[17px] font-medium">
                    Drop an English lecture here, or choose a file
                  </span>
                  <span className="text-[14px] text-cream/55">
                    Audio or mp4 video, up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB and{" "}
                    {MAX_CLIP_SECONDS / 60} minutes
                  </span>
                </span>
              </>
            ) : (
              <>
                <span className="flex size-[52px] items-center justify-center border border-cream">
                  <FileAudio className="size-5" strokeWidth={1.3} aria-hidden />
                </span>
                <span className="grid gap-1">
                  <span className="font-medium break-all">{picked.file.name}</span>
                  <span className="text-[14px] tabular-nums text-cream/55">
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
          <FieldDescription className="text-[15px] leading-normal text-stone">
            A one-minute clip takes about four minutes: Gemini listens, plans, re-teaches
            each segment, critiques itself and then speaks. Lectures with definitions,
            examples and a clear teacher voice show the most.
          </FieldDescription>
          <FieldError errors={[errors.file]} />
        </Field>
        <Field orientation="horizontal" className="justify-end">
          {isSubmitting && progress !== null ? (
            <progress
              value={progress}
              max={1}
              aria-label="Upload progress"
              className="h-1 w-full max-w-48 accent-cream"
            />
          ) : null}
          <button
            type="submit"
            className="nua-btn h-[46px] px-5 text-[16px]"
            disabled={isSubmitting || tooLong || picked === null}
          >
            {!isSubmitting
              ? "Localize to Hindi"
              : progress !== null && progress < 1
                ? `Uploading ${Math.round(progress * 100)}%`
                : "Starting the job"}
          </button>
        </Field>
      </FieldGroup>
    </form>
  );
}
