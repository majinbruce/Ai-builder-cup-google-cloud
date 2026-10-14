import Script from "next/script";
import { Hero } from "@/components/landing/hero";
import { LessonSection } from "@/components/landing/lesson-section";
import { MeasuredSection } from "@/components/landing/measured-section";
import { NuaFooter } from "@/components/landing/nua-footer";
import { ProcessSection } from "@/components/landing/process-section";
import { SignalsSection } from "@/components/landing/signals-section";
import { lessonShape, measuredStats } from "@/components/landing/data";
import { Divider } from "@/components/nua/rails";
import { jobResponse } from "@/lib/api/localize";
import { apiFetchServer } from "@/lib/api/server";
import type { Job } from "@/lib/api/schemas";

/**
 * The public demo job, or null. Any failure — none promoted yet, the API down —
 * degrades the landing page to its copy rather than to an error page: the
 * visitor can still read what the product does.
 */
async function loadDemo(): Promise<Job | null> {
  try {
    const { data } = await apiFetchServer("/api/v1/localize/demo", jobResponse);
    return data;
  } catch {
    return null;
  }
}

/**
 * The designer's landing page. Two of its sections are the demo lecture's own
 * data — the shape of the lesson, and the model's stress claims against the
 * measurements — so they appear only when a demo job is promoted, rather than
 * as numbers the pipeline never produced.
 */
export default async function LandingPage() {
  const demo = await loadDemo();
  const shape = demo === null ? null : lessonShape(demo);
  const stats = demo === null ? null : measuredStats(demo);

  return (
    <div className="relative">
      {/* The designer's canvas drawings; each section waits for its global. */}
      <Script src="/nua/mini-anims.js" strategy="afterInteractive" />
      <Script src="/nua/lesson-glow.js" strategy="afterInteractive" />
      <Script src="/nua/seam.js" strategy="afterInteractive" />

      <Hero />
      <Divider />
      <ProcessSection />
      <Divider />
      {shape === null ? null : <LessonSection shape={shape} />}
      {shape === null || stats === null ? null : <MeasuredSection stats={stats} />}
      <SignalsSection afterCream={shape !== null && stats !== null} />
      <NuaFooter />
    </div>
  );
}
