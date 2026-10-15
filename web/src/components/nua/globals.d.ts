/**
 * The designer's canvas libraries in public/nua/, loaded as plain scripts by
 * the landing page. Each sets one global; these are the calls we make on them.
 */
interface NuaAnimsLib {
  setAccent(color: string): void;
  setBg(color: string): void;
  listenA(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void;
  planB(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void;
  reteachA(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void;
  gradeB(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void;
  speakA(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void;
}

interface NuaGlowLib {
  render(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    t: number,
    state: object,
    mode: string,
    options: Record<string, unknown>
  ): void;
}

interface NuaSeamLib {
  render(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    t: number,
    options: Record<string, unknown>
  ): void;
}

interface NuaCursorLib {
  site(kind: string): void;
}

interface NuaIntroLib {
  overlay(variant: string, onStart: (totalMs: number) => void): void;
}

interface Window {
  NuaAnims?: NuaAnimsLib;
  NuaAnimFonts?: string[];
  NuaGlow?: NuaGlowLib;
  NuaSeam?: NuaSeamLib;
  NuaCursor?: NuaCursorLib;
  NuaIntro?: NuaIntroLib;
  __nuaIntroDone?: boolean;
}
