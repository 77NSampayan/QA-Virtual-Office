/**
 * Static furniture and wall displays of the functional rooms (pixel rectangles, painted once with the building).
 * Nothing here shows data: screens and boards are dark or show a neutral pattern. A display only shows numbers
 * once a real integration provides them.
 */
import { TILE, type DecorItem } from './map.ts';

const OUT = '#0b0f1a';

function frame(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, edge = OUT): void {
  ctx.fillStyle = edge;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = fill;
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
}

/** A standing server rack (1x2 tiles): dark case, rows of small lights. */
function rack(ctx: CanvasRenderingContext2D, px: number, py: number): void {
  frame(ctx, px + 1, py + 1, TILE - 2, TILE * 2 - 2, '#1c2540');
  for (let r = 0; r < 5; r++) {
    ctx.fillStyle = '#2f3b63';
    ctx.fillRect(px + 3, py + 4 + r * 5, TILE - 6, 3);
    ctx.fillStyle = r % 2 ? '#4be37c' : '#2fe0e6';
    ctx.fillRect(px + 4, py + 5 + r * 5, 2, 1);
  }
}

function screen(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, accent: string): void {
  frame(ctx, x, y, w, h, '#0e1526');
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.28;
  for (let yy = y + 3; yy < y + h - 2; yy += 3) ctx.fillRect(x + 2, yy, w - 4, 1); // standby scan lines, no data
  ctx.globalAlpha = 1;
}

export function paintRoomDecor(ctx: CanvasRenderingContext2D, d: DecorItem): void {
  const px = d.x * TILE;
  const py = d.y * TILE;
  const w = d.w * TILE;
  const h = d.h * TILE;
  switch (d.kind) {
    case 'rack':
      rack(ctx, px, py);
      break;
    case 'console': {
      frame(ctx, px + 1, py + 2, w - 2, h - 3, '#27324f');
      ctx.fillStyle = '#3b4a76';
      ctx.fillRect(px + 3, py + 4, w - 6, 5);
      screen(ctx, px + 5, py + 4, w - 10, 6, '#a77bff');
      ctx.fillStyle = '#ffd54a';
      for (let x = px + 6; x < px + w - 6; x += 6) ctx.fillRect(x, py + h - 8, 3, 2); // keys / buttons
      break;
    }
    case 'bench':
      frame(ctx, px + 1, py + 4, w - 2, h - 6, '#8a5a3b');
      ctx.fillStyle = '#c9d3ea';
      ctx.fillRect(px + 3, py + 6, 6, 4); // tools laid out
      ctx.fillStyle = '#ff9f43';
      ctx.fillRect(px + 12, py + 6, 5, 3);
      ctx.fillStyle = '#4ea1ff';
      ctx.fillRect(px + 21, py + 6, 8, 2);
      break;
    case 'sofa': {
      frame(ctx, px + 1, py + 2, w - 2, h - 3, '#5b4a8a');
      ctx.fillStyle = '#7a67b0';
      ctx.fillRect(px + 3, py + 4, w - 6, 5);
      ctx.fillStyle = '#463a6e';
      ctx.fillRect(px + 1, py + h - 5, w - 2, 3);
      break;
    }
    case 'fridge':
      frame(ctx, px + 2, py + 1, TILE - 4, h - 2, '#c9d3ea');
      ctx.fillStyle = '#8b97b8';
      ctx.fillRect(px + 2, py + TILE, TILE - 4, 1);
      ctx.fillRect(px + TILE - 5, py + 5, 1, 5);
      ctx.fillRect(px + TILE - 5, py + TILE + 4, 1, 5);
      break;
    case 'coffee':
      frame(ctx, px + 3, py + 2, TILE - 6, TILE - 4, '#56648a');
      ctx.fillStyle = '#ff5d6c';
      ctx.fillRect(px + 5, py + 4, 2, 2);
      ctx.fillStyle = '#e8eef9';
      ctx.fillRect(px + 6, py + 9, 4, 4);
      break;
    case 'board': {
      // the shared test planning board: columns of neutral cards (no text, no real data)
      frame(ctx, px + 2, py + 1, w - 4, TILE - 2, '#e8eef9', '#3a4560');
      const cols = ['#4ea1ff', '#4be37c', '#ffd54a'];
      for (let c = 0; c < 3; c++) {
        const x = px + 5 + c * Math.floor((w - 10) / 3);
        ctx.fillStyle = '#8b97b8';
        ctx.fillRect(x, py + 3, Math.floor((w - 10) / 3) - 2, 1);
        for (let r = 0; r < 2; r++) {
          ctx.fillStyle = cols[(c + r) % 3]!;
          ctx.fillRect(x, py + 5 + r * 4, 5, 3);
        }
      }
      break;
    }
    case 'wallscreen':
      screen(ctx, px + 2, py + 2, w - 4, TILE - 5, '#2fe0e6');
      break;
    case 'statusboard':
      frame(ctx, px + 2, py + 1, w - 4, TILE - 3, '#10182c', '#3a4560');
      for (let i = 0; i < Math.floor((w - 8) / 6); i++) {
        ctx.fillStyle = '#2a3552'; // lamps stay dark: no status is shown without real data
        ctx.fillRect(px + 5 + i * 6, py + 4, 4, 3);
        ctx.fillRect(px + 5 + i * 6, py + 9, 4, 3);
      }
      break;
    case 'apimon':
      screen(ctx, px + 2, py + 2, w - 4, TILE - 5, '#4be37c');
      ctx.fillStyle = '#2a3552';
      ctx.fillRect(px + 5, py + TILE - 6, w - 10, 1);
      break;
    case 'pipewall': {
      // the monitoring wall: a grid of dark panels; they light only when a real pipeline provides data
      frame(ctx, px + 1, py + 1, w - 2, TILE - 2, '#0b0f1a', '#3a4560');
      const n = Math.floor(w / 16);
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = '#16213a';
        ctx.fillRect(px + 3 + i * 16, py + 3, 13, TILE - 7);
        ctx.fillStyle = '#2a3552';
        ctx.fillRect(px + 5 + i * 16, py + 5, 9, 1);
        ctx.fillRect(px + 5 + i * 16, py + 8, 6, 1);
      }
      break;
    }
    case 'invboard': {
      frame(ctx, px + 2, py + 1, w - 4, TILE - 2, '#4a3a2a', '#2a1d14'); // a cork board with pinned, empty notes
      ctx.fillStyle = '#e8eef9';
      for (let i = 0; i < Math.floor((w - 8) / 12); i++) ctx.fillRect(px + 5 + i * 12, py + 4 + (i % 2) * 4, 8, 6);
      ctx.fillStyle = '#ff5d6c';
      ctx.fillRect(px + 8, py + 3, 1, 1);
      break;
    }
    case 'warn':
      frame(ctx, px + 4, py + 3, 8, 8, '#3a2a10', '#1a1006');
      ctx.fillStyle = '#c98a1a'; // an unlit warning lamp (subtle, not an alarm)
      ctx.fillRect(px + 6, py + 5, 4, 4);
      break;
    default:
      break;
  }
}
