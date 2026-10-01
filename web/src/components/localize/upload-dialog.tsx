"use client";

import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { UploadForm } from "@/components/localize/upload-form";

/**
 * The library's "Upload video" button. The form inside is the same one the
 * empty library shows inline; on success it navigates to the new video's
 * page, which closes this dialog with the route.
 */
export function UploadDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>
          <Upload /> Upload video
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Localize a lecture</DialogTitle>
          <DialogDescription>
            An English lecture in, a Hindi one out, keeping what the teacher defined,
            stressed and warned about.
          </DialogDescription>
        </DialogHeader>
        <UploadForm />
      </DialogContent>
    </Dialog>
  );
}
