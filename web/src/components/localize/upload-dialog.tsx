"use client";

import { useState } from "react";
import { Upload, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Corners } from "@/components/nua/rails";
import { UploadForm } from "@/components/localize/upload-form";
import { cn } from "@/lib/utils";

/**
 * The library's dropzone: click it for the "Localize a lecture" dialog, or drop
 * a file on it and the dialog opens with that file already chosen. On success
 * the form navigates to the new video's page, which closes this with the route.
 */
export function UploadDialog() {
  const [open, setOpen] = useState(false);
  const [dropped, setDropped] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setDropped(null);
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          setDropped(event.dataTransfer.files[0] ?? null);
          setOpen(true);
        }}
        className={cn(
          "flex h-[max(220px,18vw)] w-full flex-col items-center justify-center gap-3.5 border border-dashed transition-colors hover:border-cream hover:bg-cream/4 nua-focus",
          dragging ? "border-cream bg-cream/6" : "border-cream/35"
        )}
      >
        <span className="flex h-[46px] items-center gap-2.5 bg-cream px-[18px] text-[16px] text-ink">
          <Upload className="size-4" strokeWidth={1.5} aria-hidden /> Upload video
        </span>
        <span className="text-[14px] text-cream/50">or drop a lecture here</span>
      </button>

      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-48px)] w-[min(760px,calc(100%-48px))] max-w-none flex-col gap-6 overflow-visible rounded-none border border-cream/16 bg-panel p-[max(20px,2.5vw)] text-cream ring-0 sm:max-w-none"
      >
        <Corners />
        <div className="flex items-start justify-between gap-6">
          <div className="flex flex-col gap-3">
            <DialogTitle className="nua-display text-[40px] leading-[1.05] tracking-[-0.035em]">
              Localize a <em>lecture</em>
            </DialogTitle>
            <DialogDescription className="text-[16px] leading-[1.45] text-pretty text-cream/62">
              An English lecture in, a Hindi one out, keeping what the teacher defined, stressed
              and warned about.
            </DialogDescription>
          </div>
          <DialogClose
            aria-label="Close"
            className="flex size-10 shrink-0 items-center justify-center border border-cream/30 transition-colors hover:bg-cream hover:text-ink nua-focus"
          >
            <X className="size-3.5" strokeWidth={1.5} />
          </DialogClose>
        </div>
        <div className="overflow-y-auto">
          <UploadForm initialFile={dropped} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
