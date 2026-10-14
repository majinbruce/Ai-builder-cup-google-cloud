import type { Metadata } from "next";
import Link from "next/link";
import { WatchView } from "@/components/watch/watch-view";
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
      <div className="nua-page mx-auto grid max-w-xl justify-items-center gap-4 px-4 pb-24 text-center">
        <h1 className="nua-display text-[44px]">
          The demo lecture is not <em>set up</em>
        </h1>
        <p className="text-[15px] text-stone">
          Run a job, then promote it with{" "}
          <code className="bg-panel-2 px-1 font-mono">
            npm run localize:promote-demo -- &lt;jobId&gt;
          </code>
          . Meanwhile you can localize a clip of your own.
        </p>
        <Link href="/localize" className="nua-btn">
          Localize a clip
        </Link>
      </div>
    );
  }

  return <WatchView initialJob={job} demo />;
}
