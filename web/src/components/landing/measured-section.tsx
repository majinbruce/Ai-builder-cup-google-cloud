"use client";

import { useEffect, useRef, useState } from "react";
import { prepareCanvas } from "@/components/nua/canvas";
import { Divider, Rails } from "@/components/nua/rails";
import { Scramble } from "@/components/nua/scramble";
import type { MeasuredStats } from "@/components/landing/data";
import { WAVE_SRC } from "@/components/landing/lesson-section";
import { cn } from "@/lib/utils";

/** Reveals an element the first time a third of it is on screen. */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting !== true) return;
        setSeen(true);
        observer.disconnect();
      },
      { threshold: 0.3 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, seen] as const;
}

const pct = (part: number, whole: number) =>
  whole === 0 ? 0 : Math.round((part / whole) * 100);

/**
 * "The model's reading is checked against the audio": how many segments the
 * model said had a stressed word, how many of those a loudness or pause
 * measurement backs up, and one segment of the demo with both readings laid
 * over its words. All of it is the demo job's corroboration, not copy.
 *
 * Its top edge is the designer's seam (public/nua/seam.js): the dark section
 * above dissolves into this cream one as it scrolls in.
 */
export function MeasuredSection({ stats }: { stats: MeasuredStats }) {
  const seamRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [firstRef, firstSeen] = useSeen<HTMLDivElement>();
  const [secondRef, secondSeen] = useSeen<HTMLDivElement>();
  const [specimenRef, specimenSeen] = useSeen<HTMLDivElement>();
  // null until the viewer picks; the specimen then flips to "Measured" by
  // itself a moment after it comes into view, so the difference is seen.
  const [mode, setMode] = useState<"model" | "measured" | null>(null);

  useEffect(() => {
    if (!specimenSeen || mode !== null) return;
    const timer = setTimeout(() => setMode((current) => current ?? "measured"), 1300);
    return () => clearTimeout(timer);
  }, [specimenSeen, mode]);

  useEffect(() => {
    let k = 0;
    let last = 0;
    let raf = requestAnimationFrame(function loop(t) {
      raf = requestAnimationFrame(loop);
      const seam = window.NuaSeam;
      const canvas = seamRef.current;
      const image = imageRef.current;
      const section = canvas?.parentElement;
      const target = prepareCanvas(canvas ?? null);
      if (seam === undefined || image === null || section == null || target === null)
        return;
      // Curtain: the dissolve plays forward once the section is well in view
      // and rewinds, faster, when it scrolls back out.
      const into = section.getBoundingClientRect().top < window.innerHeight * 0.72;
      const dt = Math.min(60, t - (last || t));
      last = t;
      k = Math.max(0, Math.min(1, k + ((into ? 1 : -1.6) * dt) / 1900));
      seam.render(target.ctx, target.w, target.h, t / 1000, {
        img: image,
        mx: 0.5,
        ov: Math.max(48, window.innerWidth * 0.045),
        cs: Math.max(11, Math.round(target.w / 100)),
        mode: "Dissolve",
        k,
        drift: 0,
        src: null,
        rain: false,
        fx: "Curtain",
      });
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const measured = mode === "measured";
  const claimedPct = pct(stats.claimed, stats.total);
  const measuredPct = pct(stats.measured, stats.total);
  const reveal = (seen: boolean) =>
    cn(
      "transition-[opacity,transform] duration-700 ease-out",
      seen ? "translate-y-0 opacity-100" : "translate-y-10 opacity-0"
    );

  return (
    <section
      aria-labelledby="measured-heading"
      className="relative z-4 bg-cream text-ink"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a canvas source, never shown */}
      <img ref={imageRef} src={WAVE_SRC} alt="" className="hidden" />
      <canvas
        ref={seamRef}
        aria-hidden
        className="pointer-events-none absolute top-[calc(-1*max(48px,4.5vw))] left-0 block h-[calc(max(48px,4.5vw)+max(200px,21vw))] w-full"
      />
      <Rails tone="ink" className="top-[max(200px,20vw)]" />

      <div className="relative grid gap-y-16 px-[5.55vw] pt-[max(260px,26.5vw)] pb-[max(64px,6vw)] md:grid-cols-[minmax(0,0.82fr)_minmax(0,1fr)] md:gap-x-[max(32px,7.2vw)]">
        <div className="flex flex-col self-start md:sticky md:top-[max(72px,5.6vw)]">
          <h2
            id="measured-heading"
            className="nua-display text-[max(40px,5vw)] leading-[1.02]"
          >
            The model’s reading is checked against the{" "}
            <em>
              <Scramble word="audio" seed={5} delayMs={250} />.
            </em>
          </h2>
          <p className="nua-lead mt-[max(16px,1.7vw)] text-ink/64">
            Nua does not take the model’s word for where the emphasis falls. Every claim
            is compared with what the recording actually shows.
          </p>
          <div className="mt-[max(32px,3.4vw)] flex flex-col gap-[max(12px,1.1vw)]">
            <Bar
              label="Model asserted"
              value={`${stats.claimed} / ${stats.total}`}
              width={firstSeen ? claimedPct : 0}
              color="#cb4e39"
            />
            <Bar
              label="Measured"
              value={`${stats.measured} / ${stats.total}`}
              width={secondSeen ? measuredPct : 0}
              color="#fab0a1"
            />
          </div>
        </div>

        <div className="flex flex-col">
          <div ref={firstRef} className={cn("pb-[max(40px,4.2vw)]", reveal(firstSeen))}>
            <Key color="#cb4e39">Model asserted</Key>
            <p className="nua-display mt-[max(8px,0.8vw)] text-[max(72px,8.6vw)] leading-none whitespace-nowrap">
              <Scramble word={`${claimedPct}%`} seed={11} durMs={900} delayMs={150} />
            </p>
            <p className="mt-[max(10px,1.1vw)] font-serif text-[max(20px,2vw)] leading-[1.2] tracking-[-0.02em] italic">
              “I detected emphasis here.”
            </p>
            <p className="mt-[max(8px,0.8vw)] text-[max(13px,1vw)] leading-[1.45] text-ink/55">
              Emphasis claimed on {stats.claimed} of {stats.total} {stats.unit}
            </p>
          </div>
          <div ref={secondRef} className={cn("pb-[max(48px,5vw)]", reveal(secondSeen))}>
            <Key color="#fab0a1">Measured</Key>
            <p className="nua-display mt-[max(8px,0.8vw)] text-[max(72px,8.6vw)] leading-none whitespace-nowrap">
              <Scramble word={`${measuredPct}%`} seed={23} durMs={900} delayMs={150} />
            </p>
            <p className="mt-[max(10px,1.1vw)] font-serif text-[max(20px,2vw)] leading-[1.2] tracking-[-0.02em] italic">
              “Only these signals showed an actual measured energy rise.”
            </p>
            <p className="mt-[max(8px,0.8vw)] text-[max(13px,1vw)] leading-[1.45] text-ink/55">
              Energy rise confirmed on {stats.measured} of {stats.total}
            </p>
          </div>
          <div
            ref={specimenRef}
            className={cn(
              "border-t border-ink/14 pt-[max(18px,1.9vw)]",
              reveal(specimenSeen)
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div
                className="flex gap-[max(10px,0.8vw)]"
                role="group"
                aria-label="Reading"
              >
                <ToggleButton pressed={!measured} onClick={() => setMode("model")}>
                  Model
                </ToggleButton>
                <ToggleButton pressed={measured} onClick={() => setMode("measured")}>
                  Measured
                </ToggleButton>
              </div>
              <span className="text-[max(12px,1vw)] text-ink/55">
                {measured
                  ? "Pink: words where the recording backs the stress up."
                  : "Red: words the model says were emphasized."}
              </span>
            </div>
            <p className="mt-[max(22px,2.3vw)] text-[max(15px,1.2vw)] leading-[1.75] tracking-[-0.01em] text-pretty">
              {stats.specimen.map((part, index) => {
                const on = measured ? part.measured : part.claimed;
                return (
                  <span
                    key={index}
                    className="transition-colors duration-400"
                    style={{
                      color: !on ? "#0d0d03" : measured ? "#fab0a1" : "#b8432f",
                      fontWeight: on ? 500 : 400,
                    }}
                  >
                    {part.text}
                  </span>
                );
              })}
            </p>
          </div>
        </div>
      </div>
      <Divider tone="ink" className="absolute inset-x-0 bottom-0" />
    </section>
  );
}

function Key({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div className="nua-caps flex items-center gap-2 text-[max(12px,0.9vw)]">
      <span className="size-[9px]" style={{ background: color }} />
      {children}
    </div>
  );
}

function Bar({
  label,
  value,
  width,
  color,
}: {
  label: string;
  value: string;
  width: number;
  color: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="nua-caps flex justify-between text-[max(12px,0.9vw)]">
        <span>{label}</span>
        <span className="text-ink/55">{value}</span>
      </div>
      <div className="h-[3px] bg-ink/10">
        <div
          className="h-full transition-[width] duration-1100 ease-[cubic-bezier(.2,.7,.2,1)]"
          style={{ width: `${width}%`, background: color }}
        />
      </div>
    </div>
  );
}

function ToggleButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "flex h-[max(40px,2.9vw)] items-center border border-ink px-[max(14px,1.1vw)] text-[max(14px,1.1vw)] transition-colors nua-focus",
        pressed ? "bg-ink text-cream" : "bg-transparent text-ink hover:bg-ink/8"
      )}
    >
      {children}
    </button>
  );
}
