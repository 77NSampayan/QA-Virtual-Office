/**
 * Canvas painting for the office (no React). The building (floors, walls with depth, door frames, decor) is
 * painted once into an offscreen canvas and only redrawn when the layout changes; every frame draws doors,
 * furniture, stations, robots and drones in depth order on top, then effects, bubbles and labels.
 * Sprites are the same pure grids as everywhere else (robot, station, lounge furniture, drone).
 * Effects (confetti, rain) are computed from a seed and the scene clock: no randomness, no wall clock.
 */
import { currentBubble, ROBOT_TYPE_INFO, STATUS_COLOR, type RobotPalette, type RobotStatus, type RobotType } from '@qavo/shared';
import type { Grid } from '../sprites/grid.ts';
import { DRONE_H, DRONE_W, renderDrone } from '../sprites/drone.ts';
import { renderNookBack, renderNookFront, NOOK_H, NOOK_W, type NookKind } from '../sprites/nook.ts';
import { renderRobot, ROBOT_H, ROBOT_W } from '../sprites/robot.ts';
import { renderStation, STATION_H, STATION_W } from '../sprites/station.ts';
import { screenToWorld, worldToScreen, type Camera, type View } from './camera.ts';
import { TILE, tileAt, type OfficeMap, type RoomInfo, type TileKind } from './map.ts';
import type { Light } from './light.ts';
import { drawHat, drawNight, drawShafts, drawThemeAnimated, drawWindows, paintThemeStatic } from './paintAtmosphere.ts';
import type { Actor, OfficeScene } from './scene.ts';
import type { Theme } from './theme.ts';

const ROOM_TINTS = ['#2b2f58', '#1f3b48', '#3b2f4c', '#2f4130', '#42392a', '#2a3b57'];
const HALL = ['#1b2339', '#202a45'];
const LOBBY = ['#2c3040', '#323749'];
const LOUNGE = ['#1f3a2e', '#244235'];
const NEUTRAL_WALL = { face: '#3a4560', top: '#5d6b94', dark: '#232a3d' };
const CONFETTI = ['#ff5d6c', '#ffd54a', '#4be37c', '#2fe0e6', '#a77bff', '#ff9f43'];

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const c = (sh: number) => Math.round(((pa >> sh) & 255) + (((pb >> sh) & 255) - ((pa >> sh) & 255)) * t);
  return `#${[c(16), c(8), c(0)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
const shade = (hex: string, t: number) => (t >= 0 ? mix(hex, '#ffffff', t) : mix(hex, '#000000', -t));

/** Each room's walls, trim and door take a colour from the room's floor tint. */
function wallColors(tint: number) {
  if (tint < 0) return NEUTRAL_WALL;
  const base = ROOM_TINTS[tint % ROOM_TINTS.length]!;
  const face = mix(base, '#8b97b8', 0.5);
  return { face, top: shade(face, 0.28), dark: shade(face, -0.45) };
}

// ---------------------------------------------------------------------------- sprite cache
const spriteCache = new Map<string, HTMLCanvasElement>();
function gridCanvas(key: string, g: Grid): HTMLCanvasElement {
  let c = spriteCache.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = g[0]!.length;
    c.height = g.length;
    const ctx = c.getContext('2d')!;
    g.forEach((row, y) =>
      row.forEach((color, x) => {
        if (!color) return;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1);
      }),
    );
    spriteCache.set(key, c);
  }
  return c;
}
const robotSprite = (type: RobotType, status: RobotStatus, p: RobotPalette, frame: number) =>
  gridCanvas(`r|${type}|${status}|${p.primary}|${p.accent}|${frame}`, renderRobot({ type, status, palette: p, frame }));
const stationSprite = (type: RobotType, status: RobotStatus, p: RobotPalette, frame: number) =>
  gridCanvas(`s|${type}|${status}|${p.primary}|${p.accent}|${frame}`, renderStation({ type, status, palette: p, frame }));
const nookSprite = (kind: NookKind, layer: 'back' | 'front', p: RobotPalette, frame: number) =>
  gridCanvas(`n|${kind}|${layer}|${p.accent}|${frame}`, (layer === 'back' ? renderNookBack : renderNookFront)({ kind, palette: p, frame }));
const droneSprite = (status: RobotStatus, frame: number) => gridCanvas(`d|${status}|${frame}`, renderDrone({ status, frame }));

// ---------------------------------------------------------------------------- static building
function floorColor(kind: TileKind, tint: number, x: number, y: number): string {
  const alt = (x + y) % 2;
  if (kind === 'hall' || kind === 'door') return HALL[alt]!;
  if (kind === 'lobby') return LOBBY[alt]!;
  if (kind === 'lounge') return LOUNGE[alt]!;
  const base = ROOM_TINTS[(tint < 0 ? 0 : tint) % ROOM_TINTS.length]!;
  return alt ? shade(base, 0.07) : base;
}
const isFloorLike = (k: TileKind) => k !== 'wall' && k !== 'void';

export function paintStatic(map: OfficeMap, theme: Theme = 'none'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = map.w * TILE;
  c.height = map.h * TILE;
  const ctx = c.getContext('2d')!;
  const fillTile = (x: number, y: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
  };
  const tintAt = (x: number, y: number) => (x < 0 || y < 0 || x >= map.w || y >= map.h ? -1 : (map.tint[y * map.w + x] ?? -1));
  // the room a blocked tile (desk, furniture, plant) stands in decides the floor underneath it
  const floorUnder = (x: number, y: number): { kind: TileKind; tint: number } => {
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = tileAt(map, x + dx, y + dy);
      if (k === 'room' || k === 'lobby' || k === 'lounge' || k === 'hall') return { kind: k, tint: tintAt(x + dx, y + dy) };
    }
    return { kind: 'room', tint: -1 };
  };

  // ---- floors
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const k = tileAt(map, x, y);
      if (k === 'void' || k === 'wall') continue;
      const under = k === 'room' || k === 'hall' || k === 'lobby' || k === 'lounge' || k === 'door' ? { kind: k, tint: tintAt(x, y) } : floorUnder(x, y);
      fillTile(x, y, floorColor(under.kind, under.tint, x, y));
    }
  }

  // ---- walls with depth: a lit top, a front face where floor lies below, a baseboard, per-room colour
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      if (tileAt(map, x, y) !== 'wall') continue;
      const px = x * TILE;
      const py = y * TILE;
      const neighbourTint = [tintAt(x, y + 1), tintAt(x, y - 1), tintAt(x + 1, y), tintAt(x - 1, y)].find((t) => t >= 0) ?? -1;
      const col = wallColors(neighbourTint);
      const south = tileAt(map, x, y + 1);
      const west = tileAt(map, x - 1, y);
      const east = tileAt(map, x + 1, y);
      if (isFloorLike(south)) {
        // front face (visible from the floor in front of it)
        ctx.fillStyle = col.top;
        ctx.fillRect(px, py, TILE, 5);
        ctx.fillStyle = col.face;
        ctx.fillRect(px, py + 5, TILE, TILE - 5);
        ctx.fillStyle = shade(col.face, 0.1);
        for (let vx = 0; vx < TILE; vx += 8) ctx.fillRect(px + vx, py + 6, 1, TILE - 9); // panel seams
        ctx.fillStyle = col.dark;
        ctx.fillRect(px, py + TILE - 3, TILE, 3); // baseboard
        ctx.fillStyle = shade(col.top, 0.18);
        ctx.fillRect(px, py, TILE, 1);
      } else {
        // wall seen from above
        ctx.fillStyle = col.top;
        ctx.fillRect(px, py, TILE, TILE);
        ctx.fillStyle = shade(col.top, 0.14);
        ctx.fillRect(px, py, TILE, 1);
      }
      if (isFloorLike(west)) {
        ctx.fillStyle = col.dark;
        ctx.fillRect(px, py, 2, TILE);
      }
      if (isFloorLike(east)) {
        ctx.fillStyle = col.dark;
        ctx.fillRect(px + TILE - 2, py, 2, TILE);
      }
    }
  }
  // soft shadow where a wall's face meets the floor
  for (let y = 1; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      if (tileAt(map, x, y - 1) === 'wall' && isFloorLike(tileAt(map, x, y)) && tileAt(map, x, y) !== 'door') {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
        ctx.fillRect(x * TILE, y * TILE, TILE, 3);
      }
    }
  }

  // ---- windows on the face of the outer north wall of north rooms
  for (const r of map.rooms) {
    if (r.side !== 'north') continue;
    const col = wallColors(r.tint);
    for (let x = r.x0 + 2; x < r.x0 + r.w - 2; x += 3) {
      // the recess only: the sky behind it changes with the time of day and is drawn per frame
      ctx.fillStyle = col.dark;
      ctx.fillRect(x * TILE + 1, 5, 2 * TILE - 2, 8);
    }
  }

  // ---- door frames and name plates (leaves are drawn per frame so they can swing)
  for (const r of map.rooms) {
    const col = wallColors(r.tint);
    const d0 = r.door[0]!;
    const d1 = r.door[1]!;
    const y = d0.y * TILE;
    ctx.fillStyle = '#2a1d14'; // jambs
    ctx.fillRect(d0.x * TILE, y, 2, TILE);
    ctx.fillRect((d1.x + 1) * TILE - 2, y, 2, TILE);
    ctx.fillStyle = '#4a3322'; // lintel
    ctx.fillRect(d0.x * TILE, y, 2 * TILE, 2);
    // plate on the wall beside the door, in the room's colour (grey when the room is vacant)
    const plate = r.vacant ? '#59627f' : shade(ROOM_TINTS[r.tint % ROOM_TINTS.length]!, 0.55);
    ctx.fillStyle = col.dark;
    ctx.fillRect((d0.x - 1) * TILE + 2, y + 3, 12, 7);
    ctx.fillStyle = plate;
    ctx.fillRect((d0.x - 1) * TILE + 3, y + 4, 10, 5);
    ctx.fillStyle = col.dark;
    ctx.fillRect((d0.x - 1) * TILE + 5, y + 6, 6, 1);
  }

  // ---- decor
  for (const d of map.decor) {
    const px = d.x * TILE;
    const py = d.y * TILE;
    const w = d.w * TILE;
    const h = d.h * TILE;
    switch (d.kind) {
      case 'rug':
        ctx.fillStyle = '#3a2f4c';
        ctx.fillRect(px, py, w, h);
        ctx.fillStyle = '#4a3d60';
        ctx.fillRect(px + 3, py + 3, w - 6, h - 6);
        ctx.fillStyle = '#3a2f4c';
        ctx.fillRect(px + 7, py + 7, w - 14, h - 14);
        break;
      case 'counter':
        ctx.fillStyle = '#0b0f1a';
        ctx.fillRect(px, py, w, h);
        ctx.fillStyle = '#8a5a3b';
        ctx.fillRect(px + 1, py + 1, w - 2, h - 2);
        ctx.fillStyle = '#c9d3ea';
        ctx.fillRect(px + 1, py + 1, w - 2, 4);
        ctx.fillStyle = '#56648a';
        for (let x = px + 18; x < px + w - 18; x += 40) ctx.fillRect(x, py + 6, 16, 5);
        break;
      case 'table':
        ctx.fillStyle = '#0b0f1a';
        ctx.fillRect(px, py, w, h);
        ctx.fillStyle = '#a77450';
        ctx.fillRect(px + 1, py + 1, w - 2, h - 5);
        ctx.fillStyle = '#8a5a3b';
        ctx.fillRect(px + 1, py + h - 5, w - 2, 4);
        break;
      case 'reception':
        ctx.fillStyle = '#0b0f1a';
        ctx.fillRect(px, py, w, h);
        ctx.fillStyle = '#56648a';
        ctx.fillRect(px + 1, py + 1, w - 2, h - 5);
        ctx.fillStyle = '#2b3247';
        ctx.fillRect(px + 1, py + h - 5, w - 2, 4);
        ctx.fillStyle = '#ffd54a';
        ctx.fillRect(px + 8, py + 4, 10, 3);
        break;
      case 'plant':
        ctx.fillStyle = '#0b0f1a';
        ctx.fillRect(px + 4, py + 9, 8, 6);
        ctx.fillStyle = '#8a5a3b';
        ctx.fillRect(px + 5, py + 10, 6, 4);
        ctx.fillStyle = '#2f9e5a';
        ctx.fillRect(px + 3, py + 3, 10, 7);
        ctx.fillStyle = '#4be37c';
        ctx.fillRect(px + 5, py + 1, 6, 5);
        break;
      case 'sign':
        break;
    }
  }

  paintThemeStatic(ctx, map, theme);

  // ---- elevator shaft (the sliding doors are drawn per frame)
  const e = map.lobby.elevator;
  ctx.fillStyle = '#0b0f1a';
  ctx.fillRect(e.x * TILE - 2, e.y * TILE - 2, e.w * TILE + 4, e.h * TILE + 4);
  ctx.fillStyle = '#10182c';
  ctx.fillRect(e.x * TILE, e.y * TILE, e.w * TILE, e.h * TILE);
  ctx.fillStyle = '#2a3552';
  ctx.fillRect(e.x * TILE + 2, e.y * TILE + 2, e.w * TILE - 4, 3);
  ctx.fillStyle = '#ffd54a';
  ctx.fillRect(e.x * TILE + (e.w * TILE) / 2 - 2, e.y * TILE - 6, 4, 3);
  return c;
}

// ---------------------------------------------------------------------------- per-frame drawing
interface Drawable {
  z: number;
  tie: string;
  draw: (ctx: CanvasRenderingContext2D) => void;
}
const OFF_PALETTE: RobotPalette = ROBOT_TYPE_INFO.qa_analyst.defaultPalette;

/** Door leaves: closed they fill the 2-tile doorway; opening, they swing back to the sides. */
function drawDoor(ctx: CanvasRenderingContext2D, r: RoomInfo, open: number): void {
  const d0 = r.door[0]!;
  const x = d0.x * TILE;
  const y = d0.y * TILE;
  const base = shade(ROOM_TINTS[r.tint % ROOM_TINTS.length]!, 0.35);
  const leaf = r.vacant ? '#59627f' : mix(base, '#9a7655', 0.55);
  const w = Math.max(2, Math.round(TILE * (1 - open * 0.85)));
  for (const left of [true, false]) {
    const lx = left ? x + 2 : x + 2 * TILE - 2 - w;
    ctx.fillStyle = '#2a1d14';
    ctx.fillRect(lx - (left ? 0 : 1), y + 2, w + 1, TILE - 2);
    ctx.fillStyle = leaf;
    ctx.fillRect(lx, y + 3, w - (left ? 0 : 0), TILE - 4);
    if (w > 6) {
      ctx.fillStyle = shade(leaf, -0.18);
      ctx.fillRect(lx + 2, y + 5, w - 4, TILE - 8); // panel
      ctx.fillStyle = '#ffd54a';
      ctx.fillRect(left ? lx + w - 3 : lx + 1, y + 8, 2, 2); // handle
    }
  }
}

function drawLift(ctx: CanvasRenderingContext2D, map: OfficeMap, open: number): void {
  const e = map.lobby.elevator;
  const half = (e.w * TILE) / 2;
  const w = Math.max(1, Math.round(half * (1 - open * 0.92)));
  ctx.fillStyle = '#8b97b8';
  ctx.fillRect(e.x * TILE, e.y * TILE, w, e.h * TILE);
  ctx.fillRect(e.x * TILE + e.w * TILE - w, e.y * TILE, w, e.h * TILE);
  ctx.fillStyle = '#56648a';
  ctx.fillRect(e.x * TILE + w - 1, e.y * TILE, 1, e.h * TILE);
  ctx.fillRect(e.x * TILE + e.w * TILE - w, e.y * TILE, 1, e.h * TILE);
}

function drawables(scene: OfficeScene, frame: number, theme: Theme): Drawable[] {
  const out: Drawable[] = [];
  const map = scene.map;
  for (const r of map.rooms) {
    const open = scene.doors.get(r.key)?.open ?? 0;
    out.push({ z: r.door[0]!.y * TILE + 8, tie: `door-${r.key}`, draw: (ctx) => drawDoor(ctx, r, open) });
    for (const d of r.desks) {
      const owner = scene.deskOwner(r.key, d.index);
      const spr = owner ? stationSprite(owner.input.type, owner.input.status, owner.input.palette, frame) : stationSprite('qa_analyst', 'disconnected', OFF_PALETTE, 0);
      const z = (d.desk.y + 1) * TILE - 0.5;
      out.push({ z, tie: `desk-${r.key}-${d.index}`, draw: (ctx) => ctx.drawImage(spr, d.desk.x * TILE, d.desk.y * TILE, STATION_W, STATION_H) });
    }
  }
  const liftOpen = scene.lift.open;
  out.push({ z: (map.lobby.elevator.y + map.lobby.elevator.h) * TILE - 2, tie: 'lift', draw: (ctx) => drawLift(ctx, map, liftOpen) });
  const nookOccupants = new Map<number, Actor>();
  for (const a of scene.actors.values()) {
    const m = /^lounge:nook:(\d+)$/.exec(a.goal.key);
    if (m) nookOccupants.set(Number(m[1]), a);
  }
  for (const n of map.lounge.nooks) {
    const occ = nookOccupants.get(n.index);
    const pal = occ?.input.palette ?? OFF_PALETTE;
    const base = (n.nook.y + 1) * TILE;
    out.push({ z: base - 1, tie: `nookb-${n.index}`, draw: (ctx) => ctx.drawImage(nookSprite(n.kind, 'back', pal, frame), n.nook.x * TILE, n.nook.y * TILE, NOOK_W, NOOK_H) });
    out.push({ z: base + 1, tie: `nookf-${n.index}`, draw: (ctx) => ctx.drawImage(nookSprite(n.kind, 'front', pal, frame), n.nook.x * TILE, n.nook.y * TILE, NOOK_W, NOOK_H) });
  }
  for (const a of scene.actors.values()) {
    const seated = a.waypoints.length === 0 && a.goal.seat.px.x === a.x && a.goal.seat.px.y === a.y;
    const atNook = seated && /^lounge:nook:/.test(a.goal.key);
    const atDesk = seated && a.goal.where === 'desk';
    const z = atDesk ? (Math.floor(a.y / TILE) + 1) * TILE + 0.2 : atNook ? (Math.floor(a.y / TILE) + 1) * TILE : a.y;
    const bob = a.waypoints.length > 0 && Math.sin(a.phase * 14) > 0 ? -1 : 0;
    const spr = robotSprite(a.input.type, a.input.status, a.input.palette, frame);
    out.push({ z, tie: `bot-${a.id}`, draw: (ctx) => ctx.drawImage(spr, Math.round(a.x - ROBOT_W / 2), Math.round(a.y - ROBOT_H + bob), ROBOT_W, ROBOT_H) });
    if (theme !== 'none') out.push({ z: z + 0.05, tie: `hat-${a.id}`, draw: (ctx) => drawHat(ctx, bob ? { ...a, y: a.y + bob } : a, theme) });
  }
  for (const d of scene.drones.values()) {
    const bob = Math.round(Math.sin(scene.time * 4 + d.slot) * 1.5);
    out.push({ z: 1e6 + d.y, tie: `drone-${d.key}`, draw: (ctx) => ctx.drawImage(droneSprite(d.status, frame), Math.round(d.x - DRONE_W / 2), Math.round(d.y - DRONE_H / 2 + bob), DRONE_W, DRONE_H) });
  }
  return out.sort((p, q) => p.z - q.z || p.tie.localeCompare(q.tie));
}

// ---------------------------------------------------------------------------- effects (deterministic)
function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h >>> 0;
}
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function drawEffects(ctx: CanvasRenderingContext2D, scene: OfficeScene): void {
  for (const e of scene.effects) {
    const a = scene.actors.get(e.actorId);
    if (!a) continue;
    const age = scene.time - e.t0;
    if (e.kind === 'confetti') {
      const rnd = lcg(hash(e.actorId) + Math.round(e.t0 * 1000));
      const fade = age > e.dur - 0.6 ? Math.max(0, (e.dur - age) / 0.6) : 1;
      ctx.globalAlpha = fade;
      for (let i = 0; i < 28; i++) {
        const angle = -Math.PI / 2 + (rnd() - 0.5) * 2.4;
        const speed = 30 + rnd() * 50;
        const x = a.x + Math.cos(angle) * speed * age;
        const y = a.y - ROBOT_H + Math.sin(angle) * speed * age + 0.5 * 110 * age * age;
        ctx.fillStyle = CONFETTI[i % CONFETTI.length]!;
        ctx.fillRect(Math.round(x), Math.round(y), 2, 2);
      }
      ctx.globalAlpha = 1;
    } else {
      const cx = Math.round(a.x);
      const cy = Math.round(a.y - ROBOT_H - 8);
      ctx.fillStyle = '#6b7690';
      ctx.fillRect(cx - 9, cy, 18, 5);
      ctx.fillRect(cx - 6, cy - 3, 12, 4);
      ctx.fillStyle = '#8b97b8';
      ctx.fillRect(cx - 6, cy - 3, 12, 1);
      ctx.fillStyle = '#5ad1ff';
      for (let i = 0; i < 8; i++) {
        const dy = (age * 38 + i * 5) % 24;
        ctx.fillRect(cx - 8 + i * 2 + (i % 2), cy + 6 + Math.round(dy), 1, 3);
      }
    }
  }
}

// ---------------------------------------------------------------------------- frame
export interface FrameOptions {
  frame: number;
  selectedId: string | null;
  dpr: number;
  /** Wall clock in ms, used only to age out activity bubbles. */
  now: number;
  /** Label of the project that owns each room key (for the wall signs). */
  roomLabel: (key: string) => string;
  /** Name plate under a desk (the QA Team room): dimmed while nobody sits there. */
  deskLabel?: (roomKey: string, index: number) => { text: string; dim: boolean } | null;
  light: Light;
  theme: Theme;
}

export function drawFrame(ctx: CanvasRenderingContext2D, scene: OfficeScene, staticLayer: HTMLCanvasElement, cam: Camera, view: View, o: FrameOptions): void {
  const { dpr } = o;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#080b14';
  ctx.fillRect(0, 0, view.w * dpr, view.h * dpr);

  // world layer
  ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom, dpr * (view.w / 2 - cam.x * cam.zoom), dpr * (view.h / 2 - cam.y * cam.zoom));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(staticLayer, 0, 0);
  drawWindows(ctx, scene.map, o.light, o.theme);
  drawShafts(ctx, scene.map, o.light);
  for (const d of drawables(scene, o.frame, o.theme)) d.draw(ctx);
  drawNight(ctx, scene, o.light);
  drawThemeAnimated(ctx, scene, o.theme);
  drawEffects(ctx, scene);

  // screen layer: labels, name tags, bubbles, alerts
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const small = Math.max(9, Math.min(15, 3.4 * cam.zoom));
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${small}px system-ui, "Segoe UI", sans-serif`;
  const onScreen = (p: { x: number; y: number }, pad = 120) => p.x >= -pad && p.y >= -pad && p.x <= view.w + pad && p.y <= view.h + pad;
  const sign = (text: string, wx: number, wy: number, color: string) => {
    const p = worldToScreen(cam, view, wx, wy);
    if (!onScreen(p, 200)) return;
    ctx.fillStyle = color;
    ctx.fillText(text, p.x, p.y);
  };
  for (const r of scene.map.rooms) sign(r.vacant ? 'Vacant room' : o.roomLabel(r.key), (r.x0 + 1) * TILE + 3, (r.y0 + 1) * TILE + 7, r.vacant ? '#7b87a8' : '#e8eef9');
  if (o.deskLabel) {
    for (const r of scene.map.rooms) {
      for (const d of r.desks) {
        const l = o.deskLabel(r.key, d.index);
        if (!l) continue;
        const p = worldToScreen(cam, view, (d.desk.x + 1) * TILE, (d.desk.y + 1) * TILE + 6);
        if (!onScreen(p, 200)) continue;
        ctx.textAlign = 'center';
        ctx.fillStyle = l.dim ? '#7b87a8' : '#ffe9a8';
        ctx.fillText(l.text, p.x, p.y);
        ctx.textAlign = 'start';
      }
    }
  }
  sign('Lobby', 3 * TILE, 1.5 * TILE + 4, '#e8eef9');
  sign('Lounge & kitchen', (scene.map.lounge.x0 + 2) * TILE, 0.5 * TILE + 8, '#bff3d0');
  sign('Hallway', (scene.map.lounge.x0 - 7) * TILE, (scene.map.hallway.y0 + 1.5) * TILE, '#5b6788');

  const chatting = scene.chatting();
  const pulse = (Math.sin(scene.time * 7) + 1) / 2;
  const bubble = (text: string, x: number, y: number, bg: string, fg: string, border?: string) => {
    ctx.font = `600 ${small}px system-ui, "Segoe UI", sans-serif`;
    const w = ctx.measureText(text).width + 12;
    const h = small + 7;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h, w, h, 6);
    ctx.fill();
    if (border) {
      ctx.strokeStyle = border;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(x - 4, y - 1);
    ctx.lineTo(x + 4, y - 1);
    ctx.lineTo(x, y + 4);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.fillText(text, x, y - h / 2 + 1);
    ctx.textAlign = 'start';
  };
  const hourglass = (x: number, y: number, flip: boolean) => {
    const s = Math.max(5, small * 0.55);
    ctx.fillStyle = 'rgba(8, 11, 20, 0.85)';
    ctx.beginPath();
    ctx.arc(x, y, s + 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffd54a';
    ctx.beginPath();
    ctx.moveTo(x - s, y - s);
    ctx.lineTo(x + s, y - s);
    ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = flip ? '#ffd54a' : '#7a6420';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + s, y + s);
    ctx.lineTo(x - s, y + s);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#e8eef9';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - s - 1, y - s - 1, s * 2 + 2, s * 2 + 2);
  };

  for (const a of scene.actors.values()) {
    const top = worldToScreen(cam, view, a.x, a.y - ROBOT_H - 2);
    if (!onScreen(top, 100)) continue;
    const label = a.input.name;
    ctx.font = `700 ${small}px system-ui, "Segoe UI", sans-serif`;
    const w = ctx.measureText(label).width + small + 10;
    const h = small + 6;
    const alert = a.input.status === 'awaiting_permission' ? 'permission' : a.input.status === 'awaiting_input' ? 'input' : null;
    ctx.fillStyle = 'rgba(8, 11, 20, 0.82)';
    ctx.beginPath();
    ctx.roundRect(top.x - w / 2, top.y - h, w, h, 4);
    ctx.fill();
    if (alert) {
      ctx.strokeStyle = alert === 'permission' ? `rgba(255, 159, 67, ${0.55 + pulse * 0.45})` : `rgba(255, 213, 74, ${0.55 + pulse * 0.45})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else if (a.id === o.selectedId) {
      ctx.strokeStyle = '#2fe0e6';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = STATUS_COLOR[a.input.status];
    ctx.beginPath();
    ctx.arc(top.x - w / 2 + 7, top.y - h / 2, small / 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e8eef9';
    ctx.textAlign = 'left';
    ctx.fillText(label, top.x - w / 2 + 7 + small / 2 + 3, top.y - h / 2 + 1);
    ctx.textAlign = 'start';

    // alert badge: a person is needed
    if (alert) {
      const bx = top.x + w / 2 + small * 0.6;
      const by = top.y - h / 2;
      const r = small * 0.75 + pulse * 1.5;
      ctx.fillStyle = alert === 'permission' ? '#ff9f43' : '#ffd54a';
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1006';
      ctx.font = `800 ${small}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(alert === 'permission' ? '!' : '?', bx, by + 1);
      ctx.textAlign = 'start';
    }
    // activity bubble (tool category only) while working
    const text = currentBubble(a.input.status, a.input.activity, o.now);
    if (text && !alert) bubble(text, top.x, top.y - h - 3, 'rgba(232, 238, 249, 0.96)', '#0b0f1a');
    // hourglass while a command is running
    if (a.input.status === 'executing_tests') hourglass(top.x + w / 2 + small * 0.9, top.y - h / 2, o.frame % 2 === 0);
    // kitchen chat
    if (chatting.has(a.id) && (hash(a.id) + o.frame) % 4 < 2) bubble('...', top.x, top.y - h - 3, 'rgba(232, 238, 249, 0.92)', '#0b0f1a');
  }
  if (o.selectedId) {
    const a = scene.actors.get(o.selectedId);
    if (a) {
      const foot = worldToScreen(cam, view, a.x, a.y + 1);
      ctx.strokeStyle = '#2fe0e6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(foot.x, foot.y, 11 * cam.zoom, 4 * cam.zoom, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/** The robot under a screen point (topmost first), for click and double-click. */
export function hitRobot(scene: OfficeScene, cam: Camera, view: View, sx: number, sy: number): Actor | undefined {
  const w = screenToWorld(cam, view, sx, sy);
  let best: Actor | undefined;
  for (const a of scene.actors.values()) {
    if (w.x >= a.x - ROBOT_W / 2 && w.x <= a.x + ROBOT_W / 2 && w.y >= a.y - ROBOT_H && w.y <= a.y + 2 && (!best || a.y > best.y)) best = a;
  }
  return best;
}
