"use client";

import { useEffect, useRef } from "react";

/** The glyphs a word passes through before it settles. */
export const GLYPHS = "XS80#@+x";

/** A cheap integer hash: the same (a, b) always picks the same glyph. */
export function hash(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * `word` as it reads `ageMs` into a scramble lasting `durMs`: each letter
 * settles in turn, left to right; the rest cycle through GLYPHS every 55 ms.
 * A negative age is fully scrambled, an age past the duration is the word.
 */
export function scramble(
  word: string,
  ageMs: number,
  durMs: number,
  seed: number
): string {
  if (ageMs >= durMs) return word;
  const chars = Array.from(word);
  const tick = Math.floor(Math.max(0, ageMs) / 55);
  return chars
    .map((char, i) =>
      char === " " || ageMs > (durMs * (i + 1)) / (chars.length + 1)
        ? char
        : GLYPHS[hash(i + seed, tick) % GLYPHS.length]
    )
    .join("");
}

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A word that scrambles in when it first scrolls into view, and again each
 * time `word` changes. The text a screen reader gets is the word itself; the
 * glyphs are decoration and hidden from it.
 */
export function Scramble({
  word,
  seed = 5,
  durMs = 700,
  delayMs = 200,
  className,
}: {
  word: string;
  seed?: number;
  durMs?: number;
  delayMs?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (prefersReducedMotion()) {
      el.textContent = word;
      return;
    }

    let raf = 0;
    let start = -1;
    const run = (now: number) => {
      if (start < 0) start = now + delayMs;
      const text = scramble(word, now - start, durMs, seed);
      if (el.textContent !== text) el.textContent = text;
      if (text !== word || now < start) raf = requestAnimationFrame(run);
    };

    el.textContent = scramble(word, -1, durMs, seed);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting !== true) return;
        observer.disconnect();
        raf = requestAnimationFrame(run);
      },
      { threshold: 0.3 }
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [word, seed, durMs, delayMs]);

  return (
    <>
      <span ref={ref} aria-hidden className={className}>
        {word}
      </span>
      <span className="sr-only">{word}</span>
    </>
  );
}
