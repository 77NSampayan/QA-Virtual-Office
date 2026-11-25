/**
 * Atmosphere painting: window skies, sun shafts, the night overlay with warm glows, and seasonal decorations.
 * Everything here is a pure function of (map, scene clock, light, theme): no randomness, no wall clock.
 */
import { ROBOT_H } from '../sprites/robot.ts';
import type { Light } from './light.ts';
import { TILE, tileAt, type OfficeMap } from './map.ts';
import type { Actor, OfficeScene } from './scene.ts';
import type { Theme } from './theme.ts';
import { MAX_DARKNESS } from './light.ts';

const isFloorLike = (m: OfficeMap, x: number, y: number) => {
  const k = tileAt(m, x, y);
  return k !== 'wall' && k !== 'void';
};
function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 2654435761) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}
const rgba = (r: number, g: number, b: number, a: number) => 'rgba(' + r + ',' + g + ',' + b + ',' + Math.max(0, Math.min(1, a)).toFixed(3) + ')';

/** Wall tiles that have floor below them (their front face is visible): where garlands and lights hang. */
function faceTiles(map: OfficeMap): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < map.h - 1; y++) for (let x = 0; x < map.w; x++) if (tileAt(map, x, y) === 'wall' && isFloorLike(map, x, y + 1)) out.push({ x, y });
  return out;
}

// ---------------------------------------------------------------------------- windows and sun
export function drawWindows(ctx: CanvasRenderingContext2D, map: OfficeMap, light: Light, theme: Theme): void {
  let first = true;
  for (const r of map.rooms) {
    for (const x of r.windows) {
      const px = x * TILE + 3;
      ctx.fillStyle = light.sky[0];
      ctx.fillRect(px, 6, 26, 3);
      ctx.fillStyle = light.sky[1];
      ctx.fillRect(px, 9, 26, 3);
      if (light.dayness < 0.4) {
        const stars = 1 - light.dayness / 0.4;
        ctx.fillStyle = rgba(255, 255, 230, stars);
        for (let i = 0; i < 3; i++) ctx.fillRect(px + 2 + (hash(x * 7 + i) % 22), 6 + (hash(x * 3 + i * 5) % 5), 1, 1);
        if (first) {
          ctx.fillStyle = rgba(240, 240, 255, stars);
          ctx.fillRect(px + 18, 6, 4, 4);
          ctx.fillStyle = light.sky[0];
          ctx.fillRect(px + 20, 6, 3, 3); // crescent
        }
      } else if (light.dayness > 0.6) {
        ctx.fillStyle = rgba(255, 255, 255, 0.85);
        const cx = px + 3 + (hash(x) % 14);
        ctx.fillRect(cx, 7, 6, 2);
        ctx.fillRect(cx + 1, 6, 3, 1);
      }
      ctx.fillStyle = '#0b0f1a';
      ctx.fillRect(px + 12, 6, 1, 6); // window bar
      if (theme === 'christmas') {
        ctx.fillStyle = '#f4f8ff';
        ctx.fillRect(px - 2, 5, 30, 1); // snow on the sill
        ctx.fillRect(px - 1, 12, 28, 1);
      }
      first = false;
    }
  }
}

/** Sunlight falling through the windows of the north rooms (daytime only). */
export function drawShafts(ctx: CanvasRenderingContext2D, map: OfficeMap, light: Light): void {
  if (light.dayness < 0.55) return;
  const a = 0.1 * (light.dayness - 0.55) / 0.45;
  ctx.fillStyle = rgba(255, 244, 196, a);
  for (const r of map.rooms) {
    for (const x of r.windows) {
      const px = x * TILE + 3;
      ctx.beginPath();
      ctx.moveTo(px, TILE);
      ctx.lineTo(px + 26, TILE);
      ctx.lineTo(px + 26 + 30, TILE + 70);
      ctx.lineTo(px + 30, TILE + 70);
      ctx.closePath();
      ctx.fill();
    }
  }
}

// ---------------------------------------------------------------------------- night
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: [number, number, number], alpha: number): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, rgba(color[0], color[1], color[2], alpha));
  g.addColorStop(1, rgba(color[0], color[1], color[2], 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

/** A cool night overlay with warm pools of light from lit screens, hallway lamps and the lounge machines. */
export function drawNight(ctx: CanvasRenderingContext2D, scene: OfficeScene, light: Light): void {
  if (light.darkness <= 0.004) return;
  const map = scene.map;
  ctx.fillStyle = rgba(6, 10, 36, light.darkness);
  ctx.fillRect(0, 0, map.w * TILE, map.h * TILE);
  const k = light.darkness / MAX_DARKNESS; // 0..1: how much the lights show
  ctx.globalCompositeOperation = 'lighter';
  for (const r of map.rooms) {
    for (const d of r.desks) {
      const owner = scene.deskOwner(r.key, d.index);
      if (owner && owner.input.status !== 'disconnected') glow(ctx, d.desk.x * TILE + TILE, d.desk.y * TILE + 6, 34, [110, 170, 255], 0.3 * k);
    }
  }
  for (let x = 14; x < map.w - 2; x += 12) glow(ctx, x * TILE, (map.hallway.y0 + 1.2) * TILE, 52, [255, 205, 130], 0.2 * k);
  for (const a of scene.actors.values()) {
    const m = /^lounge:nook:(\d+)$/.exec(a.goal.key);
    const n = m ? map.lounge.nooks[Number(m[1])] : undefined;
    if (n && (n.kind === 'tv' || n.kind === 'arcade')) glow(ctx, n.nook.x * TILE + 24, n.nook.y * TILE + 4, 34, n.kind === 'tv' ? [120, 190, 255] : [200, 150, 255], 0.34 * k);
  }
  glow(ctx, (map.lounge.x0 + 7) * TILE, (map.lounge.y0 + map.lounge.h - 3) * TILE, 70, [255, 190, 120], 0.16 * k); // kitchen
  ctx.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------------------- seasonal decorations
function pumpkin(ctx: CanvasRenderingContext2D, px: number, py: number): void {
  ctx.fillStyle = '#0b0f1a';
  ctx.fillRect(px + 2, py + 5, 12, 10);
  ctx.fillStyle = '#ff8a1f';
  ctx.fillRect(px + 3, py + 6, 10, 8);
  ctx.fillStyle = '#ffb04d';
  ctx.fillRect(px + 4, py + 6, 3, 7);
  ctx.fillStyle = '#2f9e5a';
  ctx.fillRect(px + 7, py + 3, 2, 3);
  ctx.fillStyle = '#ffe36b'; // carved face
  ctx.fillRect(px + 5, py + 8, 2, 2);
  ctx.fillRect(px + 9, py + 8, 2, 2);
  ctx.fillRect(px + 6, py + 11, 4, 1);
}

function cobweb(ctx: CanvasRenderingContext2D, px: number, py: number, flip: boolean): void {
  ctx.fillStyle = 'rgba(235, 240, 255, 0.55)';
  const s = flip ? -1 : 1;
  for (let i = 0; i < 11; i++) {
    ctx.fillRect(px + s * i, py, 1, 1); // top edge
    ctx.fillRect(px, py + i, 1, 1); // side edge
  }
  for (let i = 0; i < 9; i++) ctx.fillRect(px + s * i, py + i, 1, 1); // diagonal
  for (let i = 0; i < 6; i++) {
    ctx.fillRect(px + s * (3 + i), py + 6 - i + 2, 1, 1);
    ctx.fillRect(px + s * (6 + (i > 2 ? 0 : i)), py + 3, 1, 1);
  }
}

function tree(ctx: CanvasRenderingContext2D, px: number, py: number): void {
  ctx.fillStyle = '#0b0f1a';
  ctx.fillRect(px + 6, py + 26, 4, 5);
  ctx.fillStyle = '#6b4a2f';
  ctx.fillRect(px + 7, py + 26, 2, 5);
  const layers: Array<[number, number, number]> = [
    [py + 18, 14, 8],
    [py + 11, 11, 8],
    [py + 5, 8, 7],
  ];
  for (const [y, w, h] of layers) {
    ctx.fillStyle = '#0b0f1a';
    ctx.fillRect(px + 8 - w / 2 - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = '#1f8a4d';
    ctx.fillRect(px + 8 - w / 2, y, w, h);
    ctx.fillStyle = '#2fb866';
    ctx.fillRect(px + 8 - w / 2 + 1, y + 1, w - 4, 1);
  }
  ctx.fillStyle = '#ffd54a'; // star
  ctx.fillRect(px + 7, py + 1, 3, 3);
  ctx.fillStyle = '#ff5d6c'; // baubles
  ctx.fillRect(px + 5, py + 21, 2, 2);
  ctx.fillRect(px + 10, py + 14, 2, 2);
  ctx.fillStyle = '#5ad1ff';
  ctx.fillRect(px + 8, py + 22, 2, 2);
  ctx.fillRect(px + 6, py + 15, 2, 2);
  ctx.fillStyle = '#c9d3ea'; // gifts
  ctx.fillRect(px - 2, py + 28, 5, 4);
  ctx.fillStyle = '#ff5d6c';
  ctx.fillRect(px - 1, py + 28, 1, 4);
  ctx.fillStyle = '#4be37c';
  ctx.fillRect(px + 11, py + 29, 5, 3);
}

/** Decorations that never move: painted once with the building. */
export function paintThemeStatic(ctx: CanvasRenderingContext2D, map: OfficeMap, theme: Theme): void {
  if (theme === 'none') return;
  const faces = faceTiles(map);
  if (theme === 'halloween') {
    for (const f of faces) {
      ctx.fillStyle = '#ff8a1f';
      ctx.fillRect(f.x * TILE, f.y * TILE + TILE - 4, TILE, 1); // orange trim
    }
    map.decor.filter((d) => d.kind === 'plant').forEach((d, i) => {
      if (i % 2 === 0) pumpkin(ctx, d.x * TILE, d.y * TILE);
    });
    for (const r of map.rooms) {
      cobweb(ctx, (r.x0 + 1) * TILE, (r.y0 + 1) * TILE + (r.side === 'north' ? 0 : 0), false);
      cobweb(ctx, (r.x0 + r.w - 1) * TILE - 1, (r.y0 + 1) * TILE, true);
    }
    cobweb(ctx, TILE, TILE, false);
    cobweb(ctx, (map.lounge.x0 + map.lounge.w - 1) * TILE - 1, TILE, true);
  } else {
    for (const f of faces) {
      for (let i = 0; i < TILE; i++) {
        const gx = f.x * TILE + i;
        const gy = f.y * TILE + 7 + Math.round(2 * Math.sin((gx / TILE) * Math.PI * 1.5));
        ctx.fillStyle = '#1f8a4d';
        ctx.fillRect(gx, gy, 1, 2);
        if (i % 5 === 2) {
          ctx.fillStyle = '#ff5d6c';
          ctx.fillRect(gx, gy + 1, 2, 2);
        }
      }
    }
    tree(ctx, 9 * TILE, 3 * TILE + 2);
  }
}

/** Decorations that move: twinkling lights and flying bats (a function of the scene clock). */
export function drawThemeAnimated(ctx: CanvasRenderingContext2D, scene: OfficeScene, theme: Theme): void {
  if (theme === 'none') return;
  const map = scene.map;
  const t = scene.time;
  if (theme === 'christmas') {
    const colors = ['#ff5d6c', '#ffd54a', '#4be37c', '#5ad1ff'];
    for (const f of faceTiles(map)) {
      for (let i = 0; i < 3; i++) {
        const gx = f.x * TILE + 2 + i * 5;
        const gy = f.y * TILE + 9 + Math.round(2 * Math.sin((gx / TILE) * Math.PI * 1.5));
        const on = (Math.floor(t * 2) + f.x + i) % 3 !== 0;
        ctx.fillStyle = on ? colors[(f.x + i) % colors.length]! : '#2a3552';
        ctx.fillRect(gx, gy, 2, 2);
      }
    }
    // a few snowflakes drifting down the hallway window light (deterministic)
    ctx.fillStyle = 'rgba(244, 248, 255, 0.8)';
    for (let i = 0; i < 18; i++) {
      const x = (hash(i * 31) % (map.w * TILE)) + Math.round(Math.sin(t + i) * 3);
      const y = (t * 14 + (hash(i * 17) % 300)) % (map.hallway.y1 * TILE - map.hallway.y0 * TILE + TILE);
      ctx.fillRect(x, map.hallway.y0 * TILE + y, 1, 1);
    }
  } else {
    const flap = Math.floor(t * 8) % 2;
    for (let i = 0; i < 3; i++) {
      const w = map.w * TILE + 60;
      const x = ((t * (16 + i * 5) + i * (w / 3)) % w) - 30;
      const y = (map.hallway.y0 + 0.6 + i * 0.8) * TILE + Math.round(Math.sin(t * 2.2 + i * 2) * 5);
      ctx.fillStyle = '#12091f';
      ctx.fillRect(Math.round(x) - 1, y, 3, 2); // body
      ctx.fillRect(Math.round(x) - 5, y - flap, 4, 2); // wings
      ctx.fillRect(Math.round(x) + 2, y - flap, 4, 2);
      ctx.fillStyle = '#ff8a1f';
      ctx.fillRect(Math.round(x), y, 1, 1); // eye
    }
  }
}

/** A themed hat on the robot's head (a Santa hat or a witch hat). */
export function drawHat(ctx: CanvasRenderingContext2D, a: Actor, theme: Theme): void {
  if (theme === 'none') return;
  const x = Math.round(a.x);
  const y = Math.round(a.y - ROBOT_H);
  if (theme === 'christmas') {
    ctx.fillStyle = '#0b0f1a';
    ctx.fillRect(x - 6, y + 4, 12, 3);
    ctx.fillRect(x - 5, y - 1, 10, 6);
    ctx.fillRect(x - 3, y - 3, 6, 3);
    ctx.fillStyle = '#e5384a';
    ctx.fillRect(x - 4, y, 8, 5);
    ctx.fillRect(x - 2, y - 2, 5, 3);
    ctx.fillStyle = '#f4f8ff';
    ctx.fillRect(x - 5, y + 5, 10, 2);
    ctx.fillRect(x + 1, y - 4, 3, 3);
  } else {
    ctx.fillStyle = '#0b0f1a';
    ctx.fillRect(x - 8, y + 4, 16, 3);
    ctx.fillRect(x - 5, y - 2, 10, 6);
    ctx.fillRect(x - 3, y - 6, 6, 5);
    ctx.fillStyle = '#4a2c7a';
    ctx.fillRect(x - 7, y + 5, 14, 1);
    ctx.fillRect(x - 4, y - 1, 8, 5);
    ctx.fillRect(x - 2, y - 5, 4, 4);
    ctx.fillStyle = '#ff8a1f';
    ctx.fillRect(x - 4, y + 2, 8, 1);
    ctx.fillStyle = '#ffd54a';
    ctx.fillRect(x - 1, y + 2, 2, 1);
  }
}
