import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { JobView } from "@/components/localize/job-view";
import { ApiError } from "@/lib/api/envelope";
import { jobResponse } from "@/lib/api/localize";
import { apiFetchServer } from "@/lib/api/server";
import type { Job } from "@/lib/api/schemas";

export const metadata: Metadata = { title: "Demo lecture" };

async function loadDemo(): Promise<Job | null> {
  try {
    const { data } = await apiFetchServer("/api/v1/localize/demo", jobResponse);
    return data;
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) return null;
    throw error;
  }
}

/**
 * The pre-computed demo job, public (SPEC section h: the deployed URL must
 * work signed-out). It is a real job the API ran, promoted with
 * `npm run localize:promote-demo`; the page renders the same JobView a signed-in
 * owner sees, pointed at the public demo audio routes.
 */
export default async function DemoPage() {
  const job = await loadDemo();

  if (job === null) {
    return (
      <div className="mx-auto grid w-full max-w-xl justify-items-center gap-3 px-4 py-24 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          The demo lecture is not set up
        </h1>
        <p className="text-sm text-muted-foreground">
          Run a job, then promote it with{" "}
          <code className="rounded bg-muted px-1">
            npm run localize:promote-demo -- &lt;jobId&gt;
          </code>
          . Meanwhile you can localize a clip of your own.
        </p>
        <Button asChild>
          <Link href="/localize">Localize a clip</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10">
      <JobView initialJob={job} demo />
    </div>
  );
}
