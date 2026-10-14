import Script from "next/script";
import { HashScroll } from "@/components/landing/hash-scroll";
import { Hero } from "@/components/landing/hero";
import { LessonSection } from "@/components/landing/lesson-section";
import { MeasuredSection } from "@/components/landing/measured-section";
import { NuaFooter } from "@/components/landing/nua-footer";
import { ProcessSection } from "@/components/landing/process-section";
import { SignalsSection } from "@/components/landing/signals-section";
import {
  SAMPLE_SHAPE,
  SAMPLE_STATS,
  lessonShape,
  measuredStats,
} from "@/components/landing/data";
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
 * The designer's landing page. Two of its sections show the demo lecture — the
 * shape of the lesson, and the model's stress claims against the measurements:
 * the promoted demo job's own data, or the designer's sample until there is one.
 */
export default async function LandingPage() {
  const demo = await loadDemo();
  const shape = (demo === null ? null : lessonShape(demo)) ?? SAMPLE_SHAPE;
  const stats = (demo === null ? null : measuredStats(demo)) ?? SAMPLE_STATS;

  return (
    <div className="relative">
      {/* The designer's canvas drawings; each section waits for its global. */}
      <Script src="/nua/mini-anims.js" strategy="afterInteractive" />
      <Script src="/nua/lesson-glow.js" strategy="afterInteractive" />
      <Script src="/nua/seam.js" strategy="afterInteractive" />

      <HashScroll />
      <Hero />
      <Divider />
      <ProcessSection />
      <Divider />
      <LessonSection shape={shape} />
      <MeasuredSection stats={stats} />
      <SignalsSection />
      <NuaFooter />
    </div>
  );
}
