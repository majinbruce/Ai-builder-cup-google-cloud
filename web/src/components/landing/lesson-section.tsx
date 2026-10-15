"use client";

import { useEffect, useRef, useState } from "react";
import { prepareCanvas } from "@/components/nua/canvas";
import { Scramble } from "@/components/nua/scramble";
import { SIGNAL_COLOR, SIGNAL_LABEL, formatTime } from "@/components/localize/format";
import type { LessonShape } from "@/components/landing/data";
import type { PedagogicalSignal } from "@/lib/api/schemas";

/** The wave image the glow at the foot of this section is drawn from. */
export const WAVE_SRC = "/nua/assets/lesson-wave-2.png";

/**
 * "The shape of a lesson": the demo lecture as Gemini heard it, one band per
 * segment coloured by what the teacher was doing. Hovering a band lights its
 * kind in the legend. Below, a glow drawn from the wave image follows the
 * pointer and ripples where it is clicked (public/nua/lesson-glow.js).
 */
export function LessonSection({ shape }: { shape: LessonShape }) {
  const [hovered, setHovered] = useState(-1);
  const glowRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointer = useRef({ x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, inside: false, hover: 0 });
  const ripples = useRef<{ x: number; y: number; t: number }[]>([]);

  useEffect(() => {
    const state = {};
    let raf = requestAnimationFrame(function loop(t) {
      raf = requestAnimationFrame(loop);
      const glow = window.NuaGlow;
      const image = imageRef.current;
      const target = prepareCanvas(glowRef.current);
      if (glow === undefined || image === null || !image.complete || target === null)
        return;
      const m = pointer.current;
      m.x += (m.tx - m.x) * 0.07;
      m.y += (m.ty - m.y) * 0.07;
      m.hover += ((m.inside ? 1 : 0) - m.hover) * 0.07;
      const seconds = t / 1000;
      ripples.current = ripples.current.filter((r) => seconds - r.t < 3.5);
      glow.render(target.ctx, target.w, target.h, seconds, state, "IMG", {
        img: image,
        hov: m.hover,
        ripples: ripples.current,
        fade: 0,
        grain: false,
        cs: Math.max(11, Math.round(target.w / 100)),
        sharp: 6,
        th: 0.12,
        halo: 0.8,
        ramp: 1.4,
        ascii: 0.7,
        dark: true,
        base: [13, 13, 3],
        mx: m.x,
        my: m.y,
      });
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const glowPoint = (event: React.MouseEvent) => {
    const rect = glowRef.current?.getBoundingClientRect();
    if (rect === undefined) return null;
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
      top: rect.top,
      height: rect.height,
    };
  };

  const kinds = [...new Set(shape.bands.map((band) => band.signal))];
  const hoveredSignal: PedagogicalSignal | undefined = shape.bands[hovered]?.signal;

  return (
    <section
      id="lesson"
      aria-labelledby="lesson-heading"
      onMouseMove={(event) => {
        const at = glowPoint(event);
        if (at === null) return;
        const m = pointer.current;
        m.inside = event.clientY > at.top - at.height * 0.4;
        m.tx = Math.max(0, Math.min(1, at.x));
        m.ty = Math.max(-0.6, Math.min(1, at.y));
      }}
      onMouseLeave={() => {
        pointer.current.inside = false;
      }}
      onClick={(event) => {
        const at = glowPoint(event);
        if (at === null || at.y < -0.1) return;
        ripples.current = [
          ...ripples.current.slice(-4),
          { x: at.x, y: Math.max(0, at.y), t: performance.now() / 1000 },
        ];
      }}
      className="relative z-4 min-h-[max(600px,54vw)] scroll-mt-4 overflow-hidden bg-ink px-[5.55vw] pt-[max(56px,7.2vw)] pb-[max(240px,22vw)]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a canvas source, never shown */}
      <img ref={imageRef} src={WAVE_SRC} alt="" className="hidden" />
      <canvas
        ref={glowRef}
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 block h-[35%] w-full"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-(--rail) w-px bg-[linear-gradient(to_bottom,rgb(255_231_206/14%)_0,rgb(255_231_206/14%)_62%,transparent_92%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-(--rail) w-px bg-[linear-gradient(to_bottom,rgb(255_231_206/14%)_0,rgb(255_231_206/14%)_62%,transparent_92%)]"
      />

      <div className="relative z-1">
        <div className="grid items-end gap-[max(28px,4.4vw)] md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <h2
            id="lesson-heading"
            className="nua-display text-[max(44px,5.3vw)] leading-none"
          >
            The shape
            <br />
            of a{" "}
            <em>
              <Scramble word="lesson" seed={5} delayMs={300} />.
            </em>
          </h2>
          <div className="flex flex-col items-start gap-[max(14px,1.4vw)]">
            <p className="nua-lead text-cream/62">
              {shape.topic}, as Gemini heard it: each band is one stretch of the lecture,
              coloured by what the teacher was doing.
            </p>
          </div>
        </div>

        <div className="mt-[max(32px,3.6vw)]">
          <div className="flex h-[max(32px,3vw)] gap-[3px]">
            {shape.bands.map((band, index) => (
              <div
                key={index}
                onMouseEnter={() => setHovered(index)}
                onMouseLeave={() => setHovered(-1)}
                title={`${SIGNAL_LABEL[band.signal]} · ${formatTime(band.startSec)}`}
                className="min-w-[2px] transition-opacity duration-200"
                style={{
                  flex: `${band.spanSec} 1 0px`,
                  background: SIGNAL_COLOR[band.signal],
                  opacity: hovered < 0 || hovered === index ? 1 : 0.35,
                }}
              />
            ))}
          </div>
          <div className="mt-[max(8px,0.7vw)] flex justify-between text-[max(12px,0.9vw)] text-cream/50">
            <span>0:00.0</span>
            <span>{formatTime(shape.durationSec)}</span>
          </div>
          <ul className="mt-[max(10px,1vw)] flex flex-wrap gap-[max(14px,1.5vw)] text-[max(12px,0.9vw)]">
            {kinds.map((signal) => (
              <li
                key={signal}
                className="flex items-center gap-2 transition-colors duration-200"
                style={{
                  color:
                    hoveredSignal === undefined || hoveredSignal === signal
                      ? "#ffe7ce"
                      : "rgb(255 231 206 / 38%)",
                }}
              >
                <span
                  className="size-[9px]"
                  style={{ background: SIGNAL_COLOR[signal] }}
                />
                {SIGNAL_LABEL[signal]}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
