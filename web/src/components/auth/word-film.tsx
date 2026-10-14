"use client";

import { useEffect, useRef } from "react";
import { hash, prefersReducedMotion, scramble } from "@/components/nua/scramble";

/** English words and their Hindi, for the boxes the pointer leaves behind. */
const WORDS: [string, string][] = [
  ["account", "खाता"],
  ["welcome", "स्वागत"],
  ["lesson", "पाठ"],
  ["voice", "आवाज़"],
  ["meaning", "अर्थ"],
  ["teacher", "शिक्षक"],
  ["learn", "सीखना"],
];
const SIZE = 96;

interface Box {
  x: number;
  y: number;
  start: number;
  end: number;
  en: string;
  hi: string;
  seed: number;
  value: string;
  prev: Box | null;
}

/**
 * The sign-in screen's left side: the flower film, and wherever the pointer
 * moves a small magnified frame turns an English word into its Hindi.
 */
export function WordFilm() {
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = boxRef.current;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (host === null || video === null || canvas === null) return;
    video.muted = true;
    void video.play().catch(() => undefined);
    if (prefersReducedMotion()) return;

    const pointer = { x: -1, y: -1, inside: false };
    let boxes: Box[] = [];
    let last: Box | null = null;
    let lx: number | null = null;
    let ly = 0;
    let lt = -1e9;
    let count = 0;

    const onMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      pointer.inside =
        pointer.x > 70 && pointer.x < rect.width - 70 && pointer.y > 70 && pointer.y < rect.height - 70;
      host.style.cursor = pointer.inside ? "none" : "";
    };
    const onLeave = () => {
      pointer.inside = false;
      host.style.cursor = "";
    };
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);

    let raf = requestAnimationFrame(function loop(t) {
      raf = requestAnimationFrame(loop);
      const W = canvas.offsetWidth;
      const H = canvas.offsetHeight;
      if (W === 0 || H === 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      const x = canvas.getContext("2d");
      if (x === null) return;
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, W, H);

      if (pointer.inside && video.videoWidth > 0) {
        const d = lx === null ? 1e9 : Math.hypot(pointer.x - lx, pointer.y - ly);
        if (d > SIZE * 1.2 && t - lt > 260) {
          const [en, hi] = WORDS[count++ % WORDS.length] ?? ["voice", "आवाज़"];
          const box: Box = {
            x: Math.max(SIZE / 2 + 8, Math.min(W - SIZE / 2 - 8, pointer.x)),
            y: Math.max(SIZE / 2 + 8, Math.min(H - SIZE / 2 - 8, pointer.y)),
            start: t,
            end: t + 2400,
            en,
            hi,
            seed: count * 17,
            value: (0.6 + (hash(count, 5) % 40) / 100).toFixed(4),
            prev: last !== null && t < last.end ? last : null,
          };
          boxes.push(box);
          last = box;
          lx = pointer.x;
          ly = pointer.y;
          lt = t;
        }
      }
      boxes = boxes.filter((b) => t < b.end);
      if (video.videoWidth === 0) return;

      // The film is object-fit: cover at 40% 50%; map canvas points back into it.
      const sc = Math.max(W / video.videoWidth, H / video.videoHeight);
      const ox = (W - video.videoWidth * sc) * 0.4;
      const oy = (H - video.videoHeight * sc) / 2;
      const sw = SIZE / 2.2 / sc;

      x.strokeStyle = "rgba(255,236,214,.75)";
      x.lineWidth = 1;
      x.beginPath();
      for (const b of boxes) {
        if (b.prev === null || !boxes.includes(b.prev)) continue;
        x.moveTo(b.prev.x, b.prev.y);
        x.lineTo(b.x, b.y);
      }
      x.stroke();

      for (const b of boxes) {
        const age = t - b.start;
        const rem = b.end - t;
        const X = Math.round(b.x - SIZE / 2);
        const Y = Math.round(b.y - SIZE / 2);
        x.globalAlpha = Math.min(1, age / 140) * Math.min(1, rem / 400);
        x.drawImage(video, (b.x - ox) / sc - sw / 2, (b.y - oy) / sc - sw / 2, sw, sw, X, Y, SIZE, SIZE);
        x.fillStyle = "rgba(13,13,3,.42)";
        x.fillRect(X, Y, SIZE, SIZE);
        x.strokeStyle = "rgba(255,236,214,.9)";
        x.strokeRect(X + 0.5, Y + 0.5, SIZE - 1, SIZE - 1);
        x.fillStyle = "#fff3e6";
        x.textBaseline = "middle";
        x.font = '500 9px "IBM Plex Mono", monospace';
        x.textAlign = "left";
        x.fillText(age < 560 ? "EN→HI" : "HI", X + 6, Y + 10);
        x.textAlign = "right";
        x.fillText(b.value, X + SIZE - 6, Y + SIZE - 9);
        x.textAlign = "center";
        x.font = age > 520 ? '400 19px "Tiro Devanagari Hindi", serif' : 'italic 600 18px "Newsreader", serif';
        x.fillText(age < 140 ? b.en : scramble(b.hi, age - 140, 380, b.seed), b.x, b.y + 1);
      }
      x.globalAlpha = 1;
      if (pointer.inside) {
        x.fillStyle = "rgba(255,255,255,.14)";
        x.beginPath();
        x.arc(pointer.x, pointer.y, 11, 0, 7);
        x.fill();
        x.fillStyle = "#fff";
        x.beginPath();
        x.arc(pointer.x, pointer.y, 4, 0, 7);
        x.fill();
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <div ref={boxRef} aria-hidden className="absolute inset-0 overflow-hidden bg-ink">
      <video
        ref={videoRef}
        src="/nua/assets/nua-flower.mp4"
        autoPlay
        muted
        loop
        playsInline
        className="absolute inset-0 size-full object-cover object-[40%_50%]"
      />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 size-full" />
    </div>
  );
}
