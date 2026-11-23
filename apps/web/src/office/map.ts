/**
 * The office building as a tile map (16x16 logical pixels per tile). Pure functions, no DOM.
 *
 *   +-------+------------------------------------------+---------+
 *   | LOBBY | project room | project room | ...  (north) | LOUNGE  |
 *   |  lift +==================HALLWAY===================+ (nooks, |
 *   |       | project room | project room | ...  (south) | kitchen)|
 *   +-------+------------------------------------------+---------+
 *
 * One room per registered project (plus "Unregistered folders" when needed, plus vacant rooms so the
 * building always has an even number of rooms). Desks and lounge nooks are 2x1 tiles; the robot sits behind
 * its desk (its feet 7 px below the desk's top edge), exactly like the classic floor.
 */
import { NOOK_KINDS, type NookKind } from '../sprites/nook.ts';

export const TILE = 16;
export const ROOM_H = 9; // interior rows of a room
export const HALL_H = 3;
export const LOBBY_W = 12; // x of the wall shared with the first rooms
export const LOUNGE_INNER_W = 19;
export const SEAT_OVERLAP_PX = 7; // robot feet sit this far below the desk's top edge
export const MIN_ROOMS = 2;

export type TileKind = 'void' | 'wall' | 'hall' | 'room' | 'lobby' | 'lounge' | 'door' | 'desk' | 'furniture' | 'elevator' | 'plant';
const WALKABLE: ReadonlySet<TileKind> = new Set(['hall', 'room', 'lobby', 'lounge', 'door']);

export interface Pt {
  x: number;
  y: number;
}
export interface Seat {
  /** Walkable tile the robot walks to first. */
  tile: Pt;
  /** Exact pixel position (feet, centre) while seated. */
  px: Pt;
}
export interface Desk extends Seat {
  index: number;
  /** Top-left tile of the 2x1 desk. */
  desk: Pt;
}
export interface NookSlot extends Seat {
  index: number;
  kind: NookKind;
  nook: Pt;
}
export interface RoomSpec {
  key: string;
  label: string;
  /** Number of robots that belong to this room (capacity grows with it). */
  robots: number;
}
export interface RoomInfo {
  key: string;
  label: string;
  vacant: boolean;
  side: 'north' | 'south';
  /** Outer box in tiles (walls included). */
  x0: number;
  y0: number;
  w: number;
  h: number;
  tint: number;
  desks: Desk[];
  /** Hallway-facing door tiles. */
  door: Pt[];
}
export interface DecorItem {
  kind: 'plant' | 'reception' | 'rug' | 'table' | 'counter' | 'sign';
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface OfficeMap {
  w: number;
  h: number;
  tiles: TileKind[];
  /** Tint index per tile for room floors (-1 elsewhere). */
  tint: number[];
  rooms: RoomInfo[];
  lounge: { x0: number; y0: number; w: number; h: number; nooks: NookSlot[]; stands: Seat[] };
  lobby: { x0: number; y0: number; w: number; h: number; elevator: { x: number; y: number; w: number; h: number }; spawn: Pt };
  decor: DecorItem[];
  hallway: { y0: number; y1: number };
}

export const tileAt = (m: OfficeMap, x: number, y: number): TileKind => (x < 0 || y < 0 || x >= m.w || y >= m.h ? 'void' : m.tiles[y * m.w + x]!);
export const isWalkable = (m: OfficeMap, x: number, y: number): boolean => WALKABLE.has(tileAt(m, x, y));
/** Feet position (centre of the tile, near its bottom) of a robot standing on a tile. */
export const tileFeet = (t: Pt): Pt => ({ x: (t.x + 0.5) * TILE, y: (t.y + 0.9) * TILE });

function seatFor(desk: Pt, tile: Pt): Seat {
  return { tile, px: { x: (desk.x + 1) * TILE, y: desk.y * TILE + SEAT_OVERLAP_PX } };
}

/** Desk grid of a template block: `cols` columns x 2 rows, desks 2x1 tiles, 4 tiles per column, robot above each desk. */
function deskGrid(x0: number, y0: number, cols: number): Desk[] {
  const out: Desk[] = [];
  for (let c = 0; c < cols; c++) {
    for (let row = 0; row < 2; row++) {
      const desk = { x: x0 + 4 * c + 1, y: y0 + (row === 0 ? 3 : 7) };
      out.push({ index: c * 2 + row, desk, ...seatFor(desk, { x: desk.x, y: desk.y - 1 }) });
    }
  }
  return out;
}

export function roomCols(robots: number): number {
  return Math.max(2, Math.ceil(robots / 2));
}

export function buildOffice(specsIn: readonly RoomSpec[]): OfficeMap {
  // at least two rooms, and an even count so both sides of the hallway line up
  const specs: RoomSpec[] = [...specsIn];
  for (let i = 0; specs.length < MIN_ROOMS || specs.length % 2 === 1; i++) specs.push({ key: `vacant-${i}`, label: 'Vacant', robots: 0 });

  const northTop = 0;
  const hallY0 = ROOM_H + 2; // 11
  const southTop = hallY0 + HALL_H; // 14
  const h = southTop + ROOM_H + 2; // 25

  // widths first
  const widths = specs.map((s) => 4 * roomCols(s.robots) + 2);
  let cursorN = LOBBY_W - 1;
  let cursorS = LOBBY_W - 1;
  const placed = specs.map((s, i) => {
    const side: 'north' | 'south' = i % 2 === 0 ? 'north' : 'south';
    const x0 = side === 'north' ? cursorN : cursorS;
    if (side === 'north') cursorN = x0 + widths[i]! - 1;
    else cursorS = x0 + widths[i]! - 1;
    return { s, side, x0, w: widths[i]! };
  });
  const loungeX = Math.max(cursorN, cursorS);
  const w = loungeX + LOUNGE_INNER_W + 2;

  const tiles: TileKind[] = Array.from({ length: w * h }, () => 'void' as TileKind);
  const tint: number[] = Array.from({ length: w * h }, () => -1);
  const set = (x: number, y: number, k: TileKind, t = -1) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    tiles[y * w + x] = k;
    tint[y * w + x] = t;
  };
  const fill = (x0: number, y0: number, ww: number, hh: number, k: TileKind, t = -1) => {
    for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + ww; x++) set(x, y, k, t);
  };
  const box = (x0: number, y0: number, ww: number, hh: number, floor: TileKind, t = -1) => {
    fill(x0, y0, ww, hh, 'wall');
    fill(x0 + 1, y0 + 1, ww - 2, hh - 2, floor, t);
  };

  const decor: DecorItem[] = [];
  const plant = (x: number, y: number) => {
    set(x, y, 'plant');
    decor.push({ kind: 'plant', x, y, w: 1, h: 1 });
  };

  // ---- lobby (full height) with the elevator in its north wall
  box(0, 0, LOBBY_W, h, 'lobby');
  const elevator = { x: 5, y: 1, w: 2, h: 2 };
  fill(elevator.x, elevator.y, elevator.w, elevator.h, 'elevator');
  fill(3, 6, 6, 1, 'furniture'); // reception desk
  decor.push({ kind: 'reception', x: 3, y: 6, w: 6, h: 1 });
  plant(2, 2);
  plant(9, 2);
  plant(2, h - 3);
  plant(9, h - 3);
  fill(2, 8, 8, 1, 'lobby');

  // ---- project rooms
  const rooms: RoomInfo[] = placed.map(({ s, side, x0, w: rw }, i) => {
    const y0 = side === 'north' ? northTop : southTop;
    const vacant = s.key.startsWith('vacant-');
    const cols = roomCols(s.robots);
    box(x0, y0, rw, ROOM_H + 2, 'room', i % 6);
    const interiorX = x0 + 1;
    const interiorY = y0 + 1;
    const desks = vacant ? [] : deskGrid(interiorX, interiorY, cols);
    for (const d of desks) fill(d.desk.x, d.desk.y, 2, 1, 'desk', i % 6);
    // door on the wall facing the hallway, over the free columns between the first two desk columns
    const doorY = side === 'north' ? y0 + ROOM_H + 1 : y0;
    const door = [
      { x: interiorX + 3, y: doorY },
      { x: interiorX + 4, y: doorY },
    ];
    for (const d of door) set(d.x, d.y, 'door');
    if (!vacant) plant(interiorX, side === 'north' ? interiorY : interiorY + ROOM_H - 1);
    return { key: s.key, label: s.label, vacant, side, x0, y0, w: rw, h: ROOM_H + 2, tint: i % 6, desks, door };
  });

  // ---- hallway (open from the lobby to the lounge)
  fill(1, hallY0, w - 2, HALL_H, 'hall');
  for (const r of rooms) for (const d of r.door) set(d.x, d.y, 'door');
  // keep the lobby/lounge walls open across the hallway rows
  for (let y = hallY0; y < hallY0 + HALL_H; y++) {
    set(LOBBY_W - 1, y, 'hall');
    set(loungeX, y, 'hall');
  }

  // ---- lounge (full height, hallway runs through it)
  const lw = LOUNGE_INNER_W + 2;
  box(loungeX, 0, lw, h, 'lounge');
  fill(loungeX + 1, hallY0, lw - 2, HALL_H, 'hall');
  for (let y = hallY0; y < hallY0 + HALL_H; y++) set(loungeX, y, 'hall');
  const loungeKinds: NookKind[] = ['couch', 'tv', 'pingpong', 'arcade', 'coffee', 'couch', 'tv', 'pingpong'];
  const nookCells = deskGrid(loungeX + 1, 1, 4); // 4 columns x 2 rows = 8 nooks
  const nooks: NookSlot[] = nookCells.map((d, i) => {
    fill(d.desk.x, d.desk.y, 2, 1, 'furniture');
    return { index: i, kind: loungeKinds[i % loungeKinds.length] ?? NOOK_KINDS[0], nook: d.desk, tile: d.tile, px: d.px };
  });
  // kitchen / hang-out area in the south half
  const kx = loungeX + 1;
  const ky = southTop + 1;
  decor.push({ kind: 'rug', x: kx + 2, y: ky + 2, w: 15, h: 6 });
  fill(kx + 2, ky + ROOM_H - 1, 15, 1, 'furniture'); // kitchen counter along the south wall
  decor.push({ kind: 'counter', x: kx + 2, y: ky + ROOM_H - 1, w: 15, h: 1 });
  fill(kx + 7, ky + 4, 5, 2, 'furniture'); // table
  decor.push({ kind: 'table', x: kx + 7, y: ky + 4, w: 5, h: 2 });
  plant(kx, ky);
  plant(kx + LOUNGE_INNER_W - 1, ky);
  plant(kx, ky + ROOM_H - 1);
  plant(kx + LOUNGE_INNER_W - 1, ky + ROOM_H - 1);
  const standTiles: Pt[] = [];
  for (let x = kx + 3; x <= kx + 15; x += 2) standTiles.push({ x, y: ky + 2 });
  for (let x = kx + 3; x <= kx + 15; x += 2) standTiles.push({ x, y: ky + 7 });
  standTiles.push({ x: kx + 6, y: ky + 4 }, { x: kx + 6, y: ky + 5 }, { x: kx + 12, y: ky + 4 }, { x: kx + 12, y: ky + 5 });
  const stands: Seat[] = standTiles.map((t) => ({ tile: t, px: tileFeet(t) }));

  return {
    w,
    h,
    tiles,
    tint,
    rooms,
    lounge: { x0: loungeX, y0: 0, w: lw, h, nooks, stands },
    lobby: { x0: 0, y0: 0, w: LOBBY_W, h, elevator, spawn: { x: elevator.x, y: elevator.y + elevator.h } },
    decor,
    hallway: { y0: hallY0, y1: hallY0 + HALL_H - 1 },
  };
}
