"use client";

import { useEffect, useRef, useState } from "react";
import { prepareCanvas } from "@/components/nua/canvas";
import { Scramble } from "@/components/nua/scramble";
import { cn } from "@/lib/utils";

/** The pipeline in five steps, each with the evidence it leaves on the page. */
export const STEPS = [
  {
    title: "Listen",
    desc: "Gemini hears the lecture itself, not a transcript, and marks each stretch by what the teacher is doing: defining, giving an example, warning, recapping.",
    note: "Every stressed word the model claims is checked against ffmpeg's loudness and pause measurements.",
    anim: "listenA",
  },
  {
    title: "Plan",
    desc: "Before translating a word, it writes a brief: who the teacher is, the register a Hindi classroom expects, and one glossary for the whole clip.",
    note: "The glossary says, per term, whether it was translated, transliterated or kept as English, and why.",
    anim: "planB",
  },
  {
    title: "Re-teach",
    desc: "Each segment is adapted in Hindi for intent, not word for word. Idioms become their Hindi equivalents; key terms stay stressed.",
    note: "A literal translation sits beside every adaptation, with a reason for each departure from it.",
    anim: "reteachA",
  },
  {
    title: "Grade itself blind",
    desc: "A separate Gemini call, which never sees the reasoning, back-translates the Hindi and scores it. Anything under 70 is rewritten once.",
    note: "The back-translation and both scores are shown, including for the drafts that failed.",
    anim: "gradeB",
  },
  {
    title: "Speak",
    desc: "Gemini's own voice speaks it, directed with the register, pace and stress it heard, and each line is fitted to the moments the teacher is speaking.",
    note: "The direction sent to the voice is shown, and so is every take that had to be recorded again to fit.",
    anim: "speakA",
  },
] as const;

/**
 * "Nua preserves what lies beneath them": the five steps as tabs, each with a
 * short looping drawing of what that step does (public/nua/mini-anims.js).
 */
export function ProcessSection() {
  const [tab, setTab] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const startedAt = useRef(0);
  const step = STEPS[tab] ?? STEPS[0];

  useEffect(() => {
    startedAt.current = performance.now();
    let raf = requestAnimationFrame(function loop(t) {
      raf = requestAnimationFrame(loop);
      const anims = window.NuaAnims;
      const target = prepareCanvas(canvasRef.current);
      if (anims === undefined || target === null) return;
      anims.setAccent("#d8dc6a");
      anims.setBg("#141507");
      anims[step.anim](
        target.ctx,
        target.w,
        target.h,
        Math.max(0, t - startedAt.current) / 1000
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [step]);

  return (
    <section
      id="process"
      aria-labelledby="process-heading"
      className="relative flex scroll-mt-4 flex-col px-[5.5vw] pt-[max(56px,4.6vw)] pb-[max(64px,4.8vw)]"
    >
      <h2
        id="process-heading"
        className="nua-display text-center text-[max(36px,3.9vw)] leading-[1.12]"
      >
        Nua preserves
        <br />
        what lies <em>beneath</em> them.
      </h2>
      <p className="nua-caps mx-auto mt-[max(24px,2.6vw)] border border-cream px-[max(12px,0.75vw)] py-2 text-[max(12px,0.95vw)]">
        Five steps, each one you can check
      </p>

      <div
        role="tablist"
        aria-label="The five steps"
        className="mt-[max(28px,2.5vw)] grid grid-cols-5 gap-[max(10px,1.7vw)]"
      >
        {STEPS.map((item, index) => (
          <button
            key={item.title}
            type="button"
            role="tab"
            id={`process-tab-${index}`}
            aria-selected={index === tab}
            aria-controls="process-panel"
            onClick={() => setTab(index)}
            className={cn(
              "nua-caps overflow-hidden border-b pb-[max(10px,0.9vw)] text-left text-[max(11px,1vw)] text-ellipsis whitespace-nowrap transition-colors hover:text-cream nua-focus",
              index === tab ? "border-cream text-cream" : "border-cream/14 text-cream/32"
            )}
          >
            {item.title}
          </button>
        ))}
      </div>

      <div
        id="process-panel"
        role="tabpanel"
        aria-labelledby={`process-tab-${tab}`}
        className="mt-[max(24px,2.5vw)] grid min-h-[max(420px,37vw)] md:grid-cols-2"
      >
        <div className="flex flex-col gap-[max(14px,1.2vw)] bg-panel p-[max(24px,2.5vw)]">
          <h3 className="text-[max(28px,2.6vw)] leading-[1.1] font-medium tracking-[-0.02em]">
            <Scramble word={step.title} seed={3} delayMs={100} />
          </h3>
          <p className="max-w-[max(300px,30vw)] text-[max(15px,1.2vw)] leading-[1.45] text-pretty text-stone">
            {step.desc}
          </p>
          <p className="mt-auto max-w-[max(300px,30vw)] border border-cream/30 p-[max(14px,1.1vw)] text-[max(15px,1.2vw)] leading-[1.45] text-pretty">
            {step.note}
          </p>
        </div>
        <div className="relative min-h-[max(300px,30vw)] bg-panel-2">
          <canvas
            ref={canvasRef}
            aria-hidden
            className="absolute inset-0 block size-full"
          />
        </div>
      </div>
    </section>
  );
}
