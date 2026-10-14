"use client";

import { useEffect, useRef, useState } from "react";
import { prepareCanvas } from "@/components/nua/canvas";
import { Divider } from "@/components/nua/rails";
import { GLYPHS, Scramble, hash } from "@/components/nua/scramble";
import { cn } from "@/lib/utils";

/** [before, the signal, after, its tag on the wave, its colour] */
const LINES = [
  ["Sometimes it is what the teacher ", "paused", " before.", "PAUSE", "#bfc26a"],
  ["What they ", "emphasized", ".", "STRESS", "#f07f6a"],
  ["What they ", "defined", ".", "DEFINE", "#f2c14e"],
  ["What they ", "returned to", ".", "RECAP", "#ef9a96"],
] as const;

/** Where on the wave (0-1) each signal's stretch lies. */
const SPANS: [number, number][] = [
  [0, 0.2],
  [0.26, 0.48],
  [0.53, 0.74],
  [0.8, 1],
];

/**
 * "What matters isn't always what was said": the four signals the pipeline
 * listens for, as a waveform. Moving the pointer along it lights the stretch
 * and the line that names it.
 */
export function SignalsSection({ afterCream = true }: { afterCream?: boolean }) {
  const [active, setActive] = useState(-1);
  const activeRef = useRef(-1);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const signalsRef = useRef<HTMLSpanElement>(null);
  const pointer = useRef({ x: 0, inside: false });

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    let raf = requestAnimationFrame(function loop(t) {
      raf = requestAnimationFrame(loop);

      // "signals" re-scrambles every 3.2 s.
      const word = signalsRef.current;
      if (word !== null) {
        const phase = t % 3200;
        const text =
          phase < 600
            ? Array.from("signals")
                .map((c, k) =>
                  phase > (600 * (k + 1)) / 8
                    ? c
                    : GLYPHS[hash(k, Math.floor(phase / 55)) % GLYPHS.length]
                )
                .join("")
            : "signals";
        if (word.textContent !== text) word.textContent = text;
      }

      const target = prepareCanvas(canvasRef.current);
      if (target === null) return;
      const { ctx, w: W, h: H } = target;
      ctx.clearRect(0, 0, W, H);
      const ts = t / 1000;
      const label = Math.max(11, W * 0.009);
      const y0 = (H - label * 2.4) / 2;
      const amax = y0 * 0.92;
      const step = Math.max(4, W / 260);
      const on = activeRef.current;
      for (let px = 0; px < W; px += step) {
        const u = px / W;
        const k = SPANS.findIndex(([a, b]) => u >= a && u <= b);
        const amp =
          k < 0
            ? 1.5
            : (amax * 0.15 + amax * 0.85 * Math.abs(Math.sin(u * 61 + ts * 2) * Math.sin(u * 17))) *
              (k === 1 && u > 0.34 && u < 0.4 ? 1.15 : 1);
        ctx.fillStyle =
          k < 0 ? "rgba(255,231,206,.18)" : k === on ? (LINES[k]?.[4] ?? "#ffe7ce") : "rgba(255,231,206,.32)";
        const a = Math.min(amp, amax);
        ctx.fillRect(px, y0 - a, Math.max(2, step * 0.4), a * 2);
      }
      ctx.font = `500 ${label}px "IBM Plex Mono", monospace`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      SPANS.forEach(([a], k) => {
        ctx.fillStyle = k === on ? (LINES[k]?.[4] ?? "#ffe7ce") : "rgba(255,231,206,.42)";
        ctx.fillText(LINES[k]?.[3] ?? "", W * a, H);
      });
      if (pointer.current.inside) {
        ctx.fillStyle = "#ffe7ce";
        ctx.fillRect(pointer.current.x, 0, 1, y0 * 2);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const onMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const u = (event.clientX - rect.left) / rect.width;
    pointer.current = { x: event.clientX - rect.left, inside: true };
    const k = SPANS.findIndex(([a, b]) => u >= a - 0.03 && u <= b + 0.03);
    if (k !== active) setActive(k);
  };

  return (
    <section
      id="signals"
      aria-labelledby="signals-heading"
      className="relative z-4 scroll-mt-4 bg-ink"
    >
      {afterCream ? (
        <div className="relative h-10 bg-cream">
          <div className="absolute inset-y-0 left-(--rail) w-px bg-ink/14" />
          <div className="absolute inset-y-0 right-(--rail) w-px bg-ink/14" />
        </div>
      ) : null}
      <div className="h-10" />
      <Divider />

      <div className="grid items-start gap-y-[max(28px,2.6vw)] px-[5.55vw] pt-[max(72px,8vw)] md:grid-cols-[minmax(0,1fr)_minmax(0,0.72fr)] md:gap-x-[max(32px,5vw)]">
        <h2
          id="signals-heading"
          className="nua-display text-[max(40px,4.75vw)] leading-[1.08] md:col-span-2"
        >
          What matters isn’t
          <br />
          always what was{" "}
          <em>
            <Scramble word="said" seed={9} durMs={600} delayMs={150} />.
          </em>
        </h2>
        <div className="flex flex-col gap-[max(4px,0.35vw)] md:col-start-2">
          {LINES.map(([pre, key, post, , color], k) => {
            const on = active === k;
            const dim = active >= 0 && !on;
            return (
              <p
                key={key}
                className={cn(
                  "font-serif text-[max(18px,1.65vw)] leading-[1.38] font-light italic transition-colors duration-300",
                  dim ? "text-cream/35" : "text-cream/72"
                )}
              >
                {pre}
                <span
                  className="border-b transition-colors duration-300"
                  style={{
                    color: on ? color : undefined,
                    borderColor: on ? color : "transparent",
                  }}
                >
                  {key}
                </span>
                {post}
              </p>
            );
          })}
          <p className="mt-[max(24px,2.6vw)] text-[max(16px,1.4vw)] leading-[1.35]">
            Nua preserves those{" "}
            <span ref={signalsRef} aria-hidden className="font-serif font-semibold text-lime italic">
              signals
            </span>
            <span className="sr-only">signals</span>.
          </p>
        </div>
      </div>

      <div
        aria-hidden
        onMouseMove={onMove}
        onMouseLeave={() => {
          pointer.current.inside = false;
          setActive(-1);
        }}
        className="relative mx-[5.55vw] mt-[max(48px,5vw)] h-[max(140px,12vw)] cursor-ew-resize"
      >
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 block size-full" />
      </div>
      <div className="h-[max(56px,5vw)]" />
      <Divider />
    </section>
  );
}
