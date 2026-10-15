"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { prefersReducedMotion, scramble } from "@/components/nua/scramble";

/** The word "voice" in the languages the boxes cycle through. */
const WORDS: [string, string][] = [
  ["ES", "voz"],
  ["FR", "voix"],
  ["DE", "Stimme"],
  ["IT", "voce"],
  ["PT", "voz"],
  ["NL", "stem"],
  ["PL", "głos"],
  ["TR", "ses"],
  ["RU", "голос"],
  ["JA", "声"],
  ["KO", "목소리"],
  ["HI", "आवाज़"],
  ["AR", "صوت"],
  ["SW", "sauti"],
];
const VALUES = [
  "0.1429",
  "0.2857",
  "0.4286",
  "0.5714",
  "0.7443",
  "0.8671",
  "1.0000",
  "1.1429",
];

interface Box {
  u: number;
  v: number;
  start: number;
  end: number;
  prev: Box | null;
  value: string;
  lang: string;
  word: string;
  seed: number;
}

/**
 * The landing page's opening: the flower film, and over it a trail of small
 * magnified frames, each one the word "voice" in another language, left
 * wherever the pointer passes over the flower. The headline's last word
 * follows the newest box, and settles back to "voice" when the pointer leaves.
 */
/** Sections a link can land on directly; arriving at one skips the intro. */
const SECTIONS = ["process", "lesson", "signals"];
const EASE = "cubic-bezier(.16,1,.3,1)";
const RISE = [
  { opacity: 0, transform: "translateY(16px)" },
  { opacity: 1, transform: "none" },
];

/**
 * The designer's opening on the first visit of a page load: the intro drawing
 * (public/nua/intro.js) over the whole screen, then the hero assembling itself
 * after it — slowly behind the intro, briskly on every later visit. Returns the
 * moment, on the animation clock, the headline is in place.
 */
function entrance(hero: HTMLElement, base: number, slow: boolean): number {
  const m = slow ? 2.4 : 1;
  const z = slow ? 1.35 : 1;
  const run = (el: Element | null | undefined, kf: Keyframe[], d: number, dur = 1100) =>
    el?.animate(kf, {
      duration: dur * z,
      delay: base + d * m,
      easing: EASE,
      fill: "backwards",
    });
  if (slow) {
    hero.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 600,
      delay: base,
      easing: EASE,
      fill: "backwards",
    });
  }
  const h1 = hero.querySelector("h1");
  run(
    document.querySelector("header nav"),
    [
      { opacity: 0, transform: "translateY(-14px)" },
      { opacity: 1, transform: "none" },
    ],
    0
  );
  run(
    hero.querySelector("video")?.parentElement,
    [
      { opacity: 0, transform: "scale(1.05)" },
      { opacity: 1, transform: "none" },
    ],
    100,
    1900
  );
  run(
    h1,
    [
      { opacity: 0, transform: "translateY(26px)", filter: "blur(12px)" },
      { opacity: 1, transform: "none", filter: "blur(0)" },
    ],
    220,
    1300
  );
  run(h1?.nextElementSibling, RISE, 460);
  run(h1?.parentElement?.lastElementChild, RISE, 580);
  return performance.now() + base + 220 * m + 350;
}

/** Each of the page's section headings drifts in the first time it scrolls into view. */
function revealHeadings(root: HTMLElement): () => void {
  const headings = [...root.querySelectorAll("h2")];
  headings.forEach((el) => (el.style.opacity = "0"));
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
        io.unobserve(entry.target);
        entry.target.style.opacity = "";
        entry.target.animate(
          [
            { opacity: 0, transform: "translateY(22px)", filter: "blur(8px)" },
            { opacity: 1, transform: "none", filter: "blur(0)" },
          ],
          { duration: 1100, easing: EASE }
        );
      }
    },
    { rootMargin: "0px 0px -12% 0px" }
  );
  headings.forEach((el) => io.observe(el));
  return () => {
    io.disconnect();
    headings.forEach((el) => (el.style.opacity = ""));
  };
}

export function Hero() {
  // An ink cover from the first paint until the intro takes over, so the hero
  // does not flash before it. Only on a page load's first visit.
  const [covered, setCovered] = useState(
    () => typeof window === "undefined" || window.__nuaIntroDone !== true
  );
  const heroRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const voiceRef = useRef<HTMLSpanElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const hero = heroRef.current;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (hero === null || video === null || canvas === null) return;

    video.muted = true;
    void video.play().catch(() => undefined);
    // Some browsers pause a muted autoplay when the tab is backgrounded.
    const playGuard = setInterval(() => {
      if (video.paused && !document.hidden) void video.play().catch(() => undefined);
    }, 1000);

    const firstVisit = window.__nuaIntroDone !== true;
    window.__nuaIntroDone = true;
    if (prefersReducedMotion()) {
      setCovered(false);
      return () => clearInterval(playGuard);
    }

    // The headline's word scrambles in once the entrance has placed it.
    let head = { to: "voice", start: 0, dur: 420 };
    let introWait: ReturnType<typeof setTimeout> | undefined;
    const enter = (base: number, slow: boolean) => {
      head = { to: "voice", start: entrance(hero, base, slow), dur: 1300 };
    };
    const skipIntro = !firstVisit || SECTIONS.includes(window.location.hash.slice(1));
    if (skipIntro) {
      setCovered(false);
      enter(0, false);
    } else {
      const startedAt = performance.now();
      const startIntro = () => {
        if (window.NuaIntro !== undefined) {
          window.NuaIntro.overlay("a", (total) => enter(total, true));
          setCovered(false);
        } else if (performance.now() - startedAt > 4000) {
          // The script never arrived: no intro, but never a page stuck under ink.
          setCovered(false);
          enter(0, false);
        } else {
          introWait = setTimeout(startIntro, 40);
        }
      };
      startIntro();
    }
    const unreveal =
      hero.parentElement === null ? () => {} : revealHeadings(hero.parentElement);

    const mouse = { x: -1, y: -1, inside: false, overUi: false };
    const onMove = (event: PointerEvent) => {
      const rect = hero.getBoundingClientRect();
      mouse.x = event.clientX - rect.left;
      mouse.y = event.clientY - rect.top;
      mouse.inside =
        mouse.y >= 0 && mouse.y <= rect.height && mouse.x >= 0 && mouse.x <= rect.width;
      mouse.overUi =
        event.target instanceof Element && event.target.closest("a,button,nav") !== null;
    };
    const onLeave = () => {
      mouse.inside = false;
    };
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);

    // Luminance of the current frame at 96 px wide: "is the pointer on the flower?"
    const sampler = document.createElement("canvas");
    const sctx = sampler.getContext("2d", { willReadFrequently: true });
    let lum: Float32Array | null = null;
    let lw = 0;
    let lh = 0;
    const sample = () => {
      if (sctx === null) return;
      const sw = 96;
      const sh = Math.max(1, Math.round((96 * video.videoHeight) / video.videoWidth));
      if (sampler.width !== sw || sampler.height !== sh) {
        sampler.width = sw;
        sampler.height = sh;
      }
      sctx.drawImage(video, 0, 0, sw, sh);
      const data = sctx.getImageData(0, 0, sw, sh).data;
      lum = new Float32Array(sw * sh);
      lw = sw;
      lh = sh;
      for (let i = 0; i < sw * sh; i += 1) {
        lum[i] =
          0.3 * (data[i * 4] ?? 0) +
          0.59 * (data[i * 4 + 1] ?? 0) +
          0.11 * (data[i * 4 + 2] ?? 0);
      }
    };
    const lumAt = (u: number, v: number) => {
      if (lum === null) return 0;
      const ci = Math.round(u * lw);
      const cj = Math.round(v * lh);
      let max = 0;
      for (let dj = -1; dj <= 1; dj += 1) {
        for (let di = -1; di <= 1; di += 1) {
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= lw || j >= lh) continue;
          max = Math.max(max, lum[j * lw + i] ?? 0);
        }
      }
      return max;
    };

    let boxes: Box[] = [];
    let wordIndex = 0;
    let onAmount = 0;
    let lastSample = -1e9;
    let cursorHidden = false;
    let shown = "voice";
    const trail = {
      lx: null as number | null,
      ly: 0,
      lt: -1e9,
      last: null as Box | null,
      off: 0,
    };

    const frame = (t: number) => {
      const rect = hero.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (ctx === null) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (rect.bottom < 0 || video.readyState < 2 || video.videoWidth === 0) return;

      const vr = video.getBoundingClientRect();
      const map = {
        ox: vr.left - rect.left,
        oy: vr.top - rect.top,
        w: vr.width,
        h: vr.height,
        vw: video.videoWidth,
        vh: video.videoHeight,
      };
      if (t - lastSample > 300) {
        sample();
        lastSample = t;
      }

      const S = Math.round(Math.max(64, Math.min(116, W * 0.062)));
      const Z = 2.2;
      const mu = (mouse.x - map.ox) / map.w;
      const mv = (mouse.y - map.oy) / map.h;
      const onFlower =
        mouse.inside &&
        !mouse.overUi &&
        mu > 0 &&
        mu < 1 &&
        mv > 0 &&
        mv < 1 &&
        lumAt(mu, mv) > (onAmount > 0.5 ? 34 : 48);
      onAmount += ((onFlower ? 1 : 0) - onAmount) * 0.2;
      if (onFlower !== cursorHidden) {
        hero.style.cursor = onFlower ? "none" : "";
        cursorHidden = onFlower;
      }

      if (onFlower) {
        const dist =
          trail.lx === null ? 1e9 : Math.hypot(mouse.x - trail.lx, mouse.y - trail.ly);
        // No box where it would cover the headline.
        const text = headRef.current?.parentElement?.getBoundingClientRect();
        const P = 18;
        const hitsText =
          text !== undefined &&
          mouse.x + S / 2 + P > text.left - rect.left &&
          mouse.x - S / 2 - P < text.right - rect.left &&
          mouse.y + S / 2 + P > text.top - rect.top &&
          mouse.y - S / 2 - P < text.bottom - rect.top;
        const wholeBoxOnFlower =
          lumAt((mouse.x - S / 2 - map.ox) / map.w, mv) > 30 &&
          lumAt((mouse.x + S / 2 - map.ox) / map.w, mv) > 30 &&
          lumAt(mu, (mouse.y - S / 2 - map.oy) / map.h) > 30 &&
          lumAt(mu, (mouse.y + S / 2 - map.oy) / map.h) > 30;
        if (dist > S * 1.3 && t - trail.lt > 280 && !hitsText && wholeBoxOnFlower) {
          const [lang, word] = WORDS[wordIndex++ % WORDS.length] ?? ["HI", "आवाज़"];
          const prev = trail.last !== null && t < trail.last.end ? trail.last : null;
          const box: Box = {
            u: mu,
            v: mv,
            start: t,
            end: t + 2400,
            prev,
            value: VALUES[Math.floor(Math.random() * VALUES.length)] ?? "1.0000",
            lang,
            word,
            seed: Math.floor(Math.random() * 1e4),
          };
          boxes.push(box);
          trail.last = box;
          trail.lx = mouse.x;
          trail.ly = mouse.y;
          trail.lt = t;
          if (head.to !== word) head = { to: word, start: t, dur: 420 };
        }
        trail.off = t;
      } else if (head.to !== "voice" && t - trail.off > 900) {
        head = { to: "voice", start: t, dur: 420 };
      }

      const want = scramble(head.to, t - head.start, head.dur, 7);
      if (want !== shown && voiceRef.current !== null) {
        voiceRef.current.textContent = want;
        shown = want;
      }

      boxes = boxes.filter((box) => t < box.end);
      const sw = (S / Z / map.w) * map.vw;
      const sh = (S / Z / map.h) * map.vh;
      const centre = new Map<Box, [number, number]>();
      ctx.save();
      for (const box of boxes) {
        const cx = map.ox + box.u * map.w;
        const cy = map.oy + box.v * map.h;
        const x = Math.round(cx - S / 2);
        const y = Math.round(cy - S / 2);
        centre.set(box, [cx, cy]);
        const age = t - box.start;
        const rem = box.end - t;
        ctx.globalAlpha = (age < 70 || rem < 60 ? 0.45 : 1) * Math.min(1, rem / 400);
        ctx.drawImage(
          video,
          box.u * map.vw - sw / 2,
          box.v * map.vh - sh / 2,
          sw,
          sh,
          x,
          y,
          S,
          S
        );
        ctx.fillStyle = "rgba(13,13,3,0.42)";
        ctx.fillRect(x, y, S, S);
        ctx.strokeStyle = "rgba(255,236,214,.88)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, S - 1, S - 1);
        ctx.shadowColor = "rgba(0,0,0,.65)";
        ctx.shadowBlur = 4;
        ctx.fillStyle = "#fff3e6";
        ctx.textBaseline = "middle";
        const word = age < 140 ? "voice" : scramble(box.word, age - 140, 380, box.seed);
        ctx.font = '500 9px "IBM Plex Mono", monospace';
        ctx.textAlign = "left";
        ctx.fillText(age < 520 ? `EN→${box.lang}` : box.lang, x + 6, y + 10);
        ctx.textAlign = "right";
        ctx.fillText(box.value, x + S - 6, y + S - 9);
        ctx.textAlign = "center";
        ctx.font = `italic 600 ${Math.round(S * 0.2)}px "Newsreader", Georgia, serif`;
        ctx.fillText(word, x + S / 2, y + S / 2);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = "rgba(255,236,214,0.8)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const box of boxes) {
        const from = box.prev === null ? undefined : centre.get(box.prev);
        const to = centre.get(box);
        if (from === undefined || to === undefined) continue;
        ctx.moveTo(from[0], from[1]);
        ctx.lineTo(to[0], to[1]);
      }
      ctx.stroke();
      ctx.restore();

      // The pointer, drawn in place of the hidden cursor.
      if (onAmount > 0.02) {
        ctx.globalAlpha = onAmount;
        ctx.fillStyle = "rgba(255,255,255,.14)";
        ctx.beginPath();
        ctx.arc(mouse.x, mouse.y, 11, 0, 7);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(mouse.x, mouse.y, 4, 0, 7);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    };

    let raf = requestAnimationFrame(function loop(t) {
      raf = requestAnimationFrame(loop);
      frame(t);
    });

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(playGuard);
      clearTimeout(introWait);
      unreveal();
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  const mask =
    "linear-gradient(to right,transparent 0,#000 8%),linear-gradient(to bottom,transparent 0,#000 6%,#000 94%,transparent 100%)";

  return (
    <div
      ref={heroRef}
      className="relative h-[calc(50vw+110px)] min-h-[670px] w-full overflow-hidden bg-ink"
    >
      <div className="absolute top-[440px] left-[-25%] aspect-[1.7843] w-[160%] md:top-[max(90px,9vw)] md:left-[32%] md:w-[80%]">
        <video
          ref={videoRef}
          src="/nua/assets/nua-flower.mp4"
          autoPlay
          muted
          loop
          playsInline
          aria-hidden
          className="absolute inset-0 block size-full"
          style={{
            WebkitMaskImage: mask,
            WebkitMaskComposite: "source-in",
            maskImage: mask,
            maskComposite: "intersect",
          }}
        />
      </div>
      <canvas
        ref={canvasRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 size-full"
      />

      <div className="pointer-events-none absolute top-[max(130px,19.4vw)] left-[6.75vw] z-2 flex flex-col items-start pr-[6vw]">
        <h1 ref={headRef} className="nua-display text-[max(40px,4.75vw)] leading-[1.08]">
          Where meaning finds a<br />
          new{" "}
          <em>
            <span ref={voiceRef} aria-hidden>
              voice
            </span>
            <span className="sr-only">voice</span>.
          </em>
        </h1>
        <p className="nua-lead mt-[max(20px,2.8vw)] max-w-[max(320px,29vw)] leading-[1.32]">
          Every lecture has a shape. Nua carries that shape into another language, and
          shows you how.
        </p>
        <div className="group/cta pointer-events-auto mt-[max(22px,2.3vw)] flex flex-wrap gap-[max(10px,0.9vw)]">
          <Link
            href="/demo"
            className="flex h-[max(42px,3.3vw)] items-center border border-cream bg-ink px-[max(14px,1.05vw)] text-[max(15px,1.25vw)] whitespace-nowrap text-cream transition-colors group-hover/cta:bg-cream group-hover/cta:text-ink nua-focus"
          >
            Watch Demo
          </Link>
          <Link
            href="/localize"
            className="flex h-[max(42px,3.3vw)] items-center border border-cream bg-cream px-[max(18px,1.6vw)] text-[max(15px,1.25vw)] whitespace-nowrap text-ink transition-colors group-hover/cta:bg-ink group-hover/cta:text-cream nua-focus"
          >
            Localize Your Clip
          </Link>
        </div>
      </div>

      {covered && (
        <div data-nua-cover aria-hidden className="fixed inset-0 z-[2147482999] bg-ink" />
      )}
    </div>
  );
}
