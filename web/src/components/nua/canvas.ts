/**
 * Sizes a canvas's backing store to its CSS box at the device pixel ratio
 * (capped at 2) and returns a context drawing in CSS pixels, or null while the
 * canvas has no size or is scrolled out of view — the loops skip those frames.
 */
export function prepareCanvas(
  canvas: HTMLCanvasElement | null,
  { onlyWhenVisible = true }: { onlyWhenVisible?: boolean } = {}
): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  if (canvas === null) return null;
  const w = canvas.offsetWidth;
  const h = canvas.offsetHeight;
  if (w === 0 || h === 0) return null;
  if (onlyWhenVisible) {
    const rect = canvas.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) return null;
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
