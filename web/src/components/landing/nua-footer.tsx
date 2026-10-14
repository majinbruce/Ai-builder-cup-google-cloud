"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { prefersReducedMotion, scramble } from "@/components/nua/scramble";

const WORDS = ["Words", "Voice", "Language", "Meaning"];
const PER_WORD_MS = 1300;

/**
 * The landing page's close: "What should remain when the language changes?",
 * answered by a giant word that scrambles from Words through Voice and
 * Language to Meaning when it scrolls into view (again on hover, once done).
 */
export function NuaFooter() {
  const wordRef = useRef<HTMLParagraphElement>(null);
  const startedAt = useRef(-1);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion()) {
      if (wordRef.current !== null) wordRef.current.textContent = "Meaning";
      return;
    }
    let shownIndex = 0;
    let raf = requestAnimationFrame(function loop(t) {
      raf = requestAnimationFrame(loop);
      const el = wordRef.current;
      if (el === null) return;
      if (startedAt.current < 0) {
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.9 && rect.bottom > 0) startedAt.current = t;
        else return;
      }
      const age = t - startedAt.current;
      const k = Math.min(3, Math.floor(age / PER_WORD_MS));
      const text = scramble(WORDS[k] ?? "Meaning", age - k * PER_WORD_MS, 600, k * 11);
      if (el.textContent !== text) el.textContent = text;
      if (k !== shownIndex) {
        shownIndex = k;
        setIndex(k);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const restart = () => {
    if (startedAt.current >= 0 && performance.now() - startedAt.current > 5300) {
      startedAt.current = performance.now();
    }
  };

  const links = [
    ["/#process", "Process"],
    ["/#lesson", "Lesson"],
    ["/#signals", "Signals"],
    ["/demo", "Demo"],
    ["/localize", "My videos"],
  ] as const;

  return (
    <footer onMouseEnter={restart} className="relative z-4 bg-ink">
      <div className="flex flex-col items-center gap-[max(16px,1.7vw)] px-[5.55vw] pt-[max(72px,6.7vw)] text-center">
        <p className="font-serif text-[max(20px,2.1vw)] leading-[1.25] font-light">
          What should remain when the language changes?
        </p>
        <p
          ref={wordRef}
          aria-hidden
          className="font-serif text-[max(72px,15.3vw)] leading-none font-semibold tracking-[-0.045em] whitespace-nowrap text-lime italic"
        >
          Meaning
        </p>
        <p className="sr-only">Meaning</p>
        <ol aria-hidden className="flex gap-[max(16px,1.95vw)] font-mono text-[max(12px,0.9vw)]">
          {WORDS.map((word, i) => (
            <li
              key={word}
              className="transition-colors duration-300"
              style={{
                color: i === index ? "#d8dc6a" : i < index ? "rgb(255 231 206 / 30%)" : "rgb(255 231 206 / 55%)",
              }}
            >
              {word.toLowerCase()}
            </li>
          ))}
        </ol>
      </div>
      <div className="mx-[5.55vw] mt-[max(64px,6.7vw)] flex flex-wrap items-center justify-between gap-6 border-t border-cream/14 py-[max(24px,2.2vw)] text-[max(14px,1.05vw)]">
        <Link href="/" className="flex nua-focus" aria-label="Nua, home">
          {/* eslint-disable-next-line @next/next/no-img-element -- a 162x80 brand mark */}
          <img
            src="/nua/assets/nua-logo.png"
            alt="nua."
            className="h-[max(26px,2.2vw)] mix-blend-lighten [filter:invert(1)_grayscale(1)_contrast(1.8)]"
          />
        </Link>
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-[max(18px,1.95vw)]">
          {links.map(([href, label]) => (
            <Link key={href} href={href} className="whitespace-nowrap hover:opacity-75 nua-focus">
              {label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="mx-[5.55vw] flex flex-wrap justify-between gap-4 pb-[max(28px,2.5vw)] text-[max(13px,0.97vw)] text-cream/55">
        <span>Built for the AI Builder Cup by Google · Gemini on Cloud Run</span>
        <span>English to Hindi, with the reasoning shown.</span>
      </div>
    </footer>
  );
}
