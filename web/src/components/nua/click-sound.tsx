"use client";

import { useEffect } from "react";

const SOURCE = "/nua/assets/click.wav";
const CLICKABLE =
  'a[href], button, [role="button"], label:has(input[type="file"]), input[type="submit"], summary';

/**
 * The designer's soft click on every press of a link or button. Decoded once,
 * on the first interaction (browsers refuse an AudioContext before one), and
 * silent for anyone who asked their system for reduced motion.
 */
export function ClickSound() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let context: AudioContext | null = null;
    let buffer: AudioBuffer | null = null;
    let loading: Promise<void> | null = null;

    const load = () => {
      context ??= new AudioContext();
      const ctx = context;
      loading ??= fetch(SOURCE)
        .then((response) => response.arrayBuffer())
        .then((bytes) => ctx.decodeAudioData(bytes))
        .then((decoded) => {
          buffer = decoded;
        })
        .catch(() => {
          loading = null;
        });
      return loading;
    };

    const play = () => {
      const ctx = context;
      if (ctx === null || buffer === null) return;
      if (ctx.state === "suspended") void ctx.resume();
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = 0.55;
      source.buffer = buffer;
      source.connect(gain).connect(ctx.destination);
      source.start();
    };

    const isClickable = (target: EventTarget | null) => {
      const el = target instanceof Element ? target.closest(CLICKABLE) : null;
      return (
        el !== null &&
        !(el as HTMLButtonElement).disabled &&
        el.getAttribute("aria-disabled") !== "true"
      );
    };

    const onPointer = (event: PointerEvent) => {
      if (event.button !== 0 || !isClickable(event.target)) return;
      if (buffer === null) void load().then(play);
      else play();
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.key === "Enter" || event.key === " ") && isClickable(document.activeElement)) {
        if (buffer === null) void load().then(play);
        else play();
      }
    };

    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      void context?.close();
    };
  }, []);

  return null;
}
