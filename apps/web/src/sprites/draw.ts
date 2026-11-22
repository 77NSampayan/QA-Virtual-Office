/** Paints a pixel grid onto a canvas at an integer scale (no smoothing, no randomness). */
import type { Grid } from './grid.ts';

export function drawGrid(ctx: CanvasRenderingContext2D, g: Grid, scale: number, ox = 0, oy = 0): void {
  g.forEach((row, y) =>
    row.forEach((c, x) => {
      if (!c) return;
      ctx.fillStyle = c;
      ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
    }),
  );
}
