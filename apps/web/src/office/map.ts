/**
 * The office building as a tile map (16x16 logical pixels per tile). Pure functions, no DOM.
 *
 *   +-------+----------+--------------+------------+
 *   | LOBBY | QA TEAM  | AUTOMATION   | API & DATA |   north rooms (one per kind of work)
 *   +-------+==========+==== HALLWAY ==============+
 *   | LOUNGE & KITCHEN | DEBUG | CI/CD   | RESERVED |   south rooms
 *   +------------------+-------+---------+----------+
 *
 * The rooms are fixed by FUNCTION, not by project: a robot goes to the room of the robot TYPE its owner chose
 * (never inferred from events). A room grows desks when more robots belong to it. The last room is kept free for
 * later. Desks and lounge nooks are 2x1 tiles; the robot sits behind its desk (feet 7 px below its top edge).
 */
import type { RobotType } from '@qavo/shared';
import { NOOK_KINDS, type NookKind } from '../sprites/nook.ts';

export const TILE = 16;
export const ROOM_H = 12; // interior rows of a room
export const HALL_H = 2;
export const LOBBY_W = 11; // outer width of the lobby (its east wall is the first room's west wall)
export const LOUNGE_W = 22;
export const SEAT_OVERLAP_PX = 7; // robot feet sit this far below the desk's top edge

export type TileKind = 'void' | 'wall' | 'hall' | 'room' | 'lobby' | 'lounge' | 'door' | 'desk' | 'furniture' | 'elevator' | 'plant';
const WALKABLE: ReadonlySet<TileKind> = new Set(['hall', 'room', 'lobby', 'lounge', 'door']);

/** The functional rooms, in building order. */
export interface RoomDef {
  key: string;
  label: string;
  side: 'north' | 'south';
  tint: number;
  minCols: number;
  minW: number;
  vacant?: boolean;
}
export const ROOM_DEFS: readonly RoomDef[] = [
  { key: 'qa', label: 'QA Team', side: 'north', tint: 0, minCols: 5, minW: 0 },
  { key: 'automation', label: 'Automation Lab', side: 'north', tint: 2, minCols: 3, minW: 0 },
  { key: 'api', label: 'API & Data Lab', side: 'north', tint: 1, minCols: 3, minW: 0 },
  { key: 'debug', label: 'Debug Lab', side: 'south', tint: 4, minCols: 3, minW: 0 },
  { key: 'cicd', label: 'CI/CD Control', side: 'south', tint: 5, minCols: 3, minW: 18 },
  { key: 'expansion', label: 'Reserved for later', side: 'south', tint: 3, minCols: 2, minW: 10, vacant: true },
];
export const ROOM_KEYS: readonly string[] = ROOM_DEFS.map((r) => r.key);

/**
 * The room that holds a robot of a type. The type is chosen by a person; nothing here looks at events.
 * Types this table does not know (older data) go to the QA Team room.
 */
const ROOM_OF_TYPE: Readonly<Record<string, string>> = {
  qa_analyst: 'qa',
  manual_tester: 'qa',
  regression_tester: 'qa',
  qa_lead: 'qa',
  automation_engineer: 'automation',
  api_tester: 'api',
  bug_investigator: 'debug',
  ci_operator: 'cicd',
};
export const roomKeyForType = (type: RobotType | string): string => ROOM_OF_TYPE[type] ?? 'qa';

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
  /** The first N desks are kept for robots that ask for a fixed desk (the named agents). */
  reserved?: number;
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
  /** Desks 0..reserved-1 belong to robots that name their desk. */
  reserved: number;
  /** Hallway-facing door tiles. */
  door: Pt[];
  /** Tile x of each window in the outer wall (north rooms only). */
  windows: number[];
}
export type DecorKind =
  | 'plant' | 'reception' | 'rug' | 'table' | 'counter' | 'sign'
  | 'sofa' | 'rack' | 'console' | 'bench' | 'fridge' | 'coffee'
  | 'board' | 'wallscreen' | 'statusboard' | 'apimon' | 'pipewall' | 'invboard' | 'warn';
export interface DecorItem {
  kind: DecorKind;
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

/** Desk grid of a block: `cols` columns x 2 rows, desks 2x1 tiles, 4 tiles per column, robot above each desk. */
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

export function roomCols(robots: number, min = 2): number {
  return Math.max(min, Math.ceil(robots / 2));
}

export function buildOffice(specsIn: readonly RoomSpec[] = []): OfficeMap {
  const spec = new Map(specsIn.map((s) => [s.key, s]));
  const BOX_H = ROOM_H + 2;
  const hallY0 = BOX_H;
  const southTop = hallY0 + HALL_H;
  const h = southTop + BOX_H;

  // widths: each room fits its desks; the last room of each row stretches so both rows end together
  const colsOf = (d: RoomDef) => roomCols(spec.get(d.key)?.robots ?? 0, d.minCols);
  const widthOf = (d: RoomDef) => Math.max(4 * colsOf(d) + 2, d.minW);
  const north = ROOM_DEFS.filter((d) => d.side === 'north');
  const south = ROOM_DEFS.filter((d) => d.side === 'south');
  const northEnd = LOBBY_W - 1 + north.reduce((s, d) => s + widthOf(d) - 1, 0);
  const southEnd = LOUNGE_W - 1 + south.reduce((s, d) => s + widthOf(d) - 1, 0);
  const lastX = Math.max(northEnd, southEnd);
  const w = lastX + 1;

  const placed: Array<{ d: RoomDef; x0: number; rw: number }> = [];
  for (const [list, start, end] of [[north, LOBBY_W - 1, northEnd], [south, LOUNGE_W - 1, southEnd]] as const) {
    let cursor = start;
    list.forEach((d, i) => {
      const last = i === list.length - 1;
      const rw = last ? widthOf(d) + (lastX - end) : widthOf(d);
      placed.push({ d, x0: cursor, rw });
      cursor += rw - 1;
    });
  }

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
  /** A floor item: it blocks walking. */
  const item = (kind: DecorKind, x: number, y: number, ww: number, hh: number) => {
    fill(x, y, ww, hh, 'furniture');
    decor.push({ kind, x, y, w: ww, h: hh });
  };
  /** A wall item: drawn on the wall face, blocks nothing. */
  const wall = (kind: DecorKind, x: number, y: number, ww: number) => decor.push({ kind, x, y, w: ww, h: 1 });

  // ---- lobby (top left) with the elevator in its north wall
  box(0, 0, LOBBY_W, BOX_H, 'lobby');
  const elevator = { x: 4, y: 1, w: 2, h: 2 };
  fill(elevator.x, elevator.y, elevator.w, elevator.h, 'elevator');
  item('reception', 3, 5, 5, 1);
  item('sofa', 1, 10, 3, 1);
  item('sofa', 7, 10, 3, 1);
  wall('wallscreen', 6, 0, 3);
  plant(2, 2);
  plant(8, 2);
  plant(1, BOX_H - 2);
  plant(LOBBY_W - 2, BOX_H - 2);
  for (const x of [4, 5]) set(x, BOX_H - 1, 'hall'); // archway to the hallway

  // ---- the functional rooms
  const rooms: RoomInfo[] = placed.map(({ d, x0, rw }) => {
    const s = spec.get(d.key);
    const vacant = d.vacant === true;
    const y0 = d.side === 'north' ? 0 : southTop;
    const ix = x0 + 1;
    const iy = y0 + 1;
    box(x0, y0, rw, BOX_H, 'room', d.tint);
    const desks = vacant ? [] : deskGrid(ix, iy, colsOf(d));
    for (const k of desks) fill(k.desk.x, k.desk.y, 2, 1, 'desk', d.tint);
    const doorY = d.side === 'north' ? y0 + BOX_H - 1 : y0;
    const door = [
      { x: ix + 3, y: doorY },
      { x: ix + 4, y: doorY },
    ];
    for (const t of door) set(t.x, t.y, 'door');
    const windows: number[] = [];
    const free = (rx: number, ry: number, ww: number, hh: number) => ({ x: x0 + rx, y: y0 + ry, ww, hh });
    const put = (kind: DecorKind, rx: number, ry: number, ww: number, hh: number) => {
      const f = free(rx, ry, ww, hh);
      item(kind, f.x, f.y, f.ww, f.hh);
    };
    const onWall = (kind: DecorKind, rx: number, ww: number) => wall(kind, x0 + rx, y0, ww);
    const plants = (...rels: Array<[number, number]>) => rels.forEach(([rx, ry]) => plant(x0 + rx, y0 + ry));
    switch (d.key) {
      case 'qa':
        windows.push(2, 5, 17);
        onWall('board', 8, 3); // shared test planning board
        onWall('wallscreen', 12, 3); // wall display for the QA summary
        put('table', 7, 10, 4, 2); // collaboration tables
        put('table', 13, 10, 4, 2);
        plants([1, 12], [rw - 2, 12]);
        break;
      case 'automation':
        windows.push(2, 10);
        onWall('statusboard', 5, 4);
        put('console', 7, 10, 4, 2); // central automation console
        plants([1, 12], [rw - 2, 12]);
        break;
      case 'api':
        windows.push(2);
        onWall('apimon', 5, 4);
        for (let i = 0; i < 3; i++) put('rack', rw - 2 - i, 11, 1, 2); // server racks
        windows.push(10);
        plants([1, 12]);
        break;
      case 'debug':
        onWall('invboard', 6, 5); // investigation board
        onWall('warn', 12, 1);
        put('bench', 7, 10, 4, 1);
        plants([1, 12], [rw - 2, 12]);
        break;
      case 'cicd':
        onWall('pipewall', 6, 8); // monitoring wall
        if (rw - 2 >= 4 * colsOf(d) + 3) {
          // free strip to the right of the desks: racks and a console
          for (let i = 0; i < 3; i++) put('rack', rw - 4 + i, 4, 1, 2);
          put('console', rw - 5, 9, 3, 2);
        } else put('console', 7, 10, 4, 2); // a bigger room has no strip: the console goes below the desks
        plants([1, 12], [rw - 2, 12]);
        break;
      default:
        plants([1, 12], [rw - 2, 12]);
    }
    return { key: d.key, label: d.label, vacant, side: d.side, x0, y0, w: rw, h: BOX_H, tint: d.tint, desks, reserved: Math.min(s?.reserved ?? 0, desks.length), door, windows: windows.map((rx) => x0 + rx) };
  });

  // ---- hallway (two rows, from the lobby to the far end)
  fill(1, hallY0, w - 2, HALL_H, 'hall');
  for (const r of rooms) for (const t of r.door) set(t.x, t.y, 'door');
  for (const x of [4, 5]) set(x, BOX_H - 1, 'hall');

  // ---- lounge and kitchen (bottom left)
  box(0, southTop, LOUNGE_W, BOX_H, 'lounge');
  for (const x of [4, 5]) set(x, southTop, 'hall'); // archway to the hallway
  const loungeKinds: NookKind[] = ['couch', 'tv', 'pingpong', 'arcade', 'coffee', 'couch', 'tv', 'pingpong'];
  const nookCells = deskGrid(1, southTop + 1, 4); // 4 columns x 2 rows = 8 nooks
  const nooks: NookSlot[] = nookCells.map((d, i) => {
    fill(d.desk.x, d.desk.y, 2, 1, 'furniture');
    return { index: i, kind: loungeKinds[i % loungeKinds.length] ?? NOOK_KINDS[0], nook: d.desk, tile: d.tile, px: d.px };
  });
  const kitchenY = southTop + BOX_H - 2; // the row against the south wall
  item('fridge', 1, kitchenY - 1, 1, 2);
  item('counter', 3, kitchenY, 8, 1);
  item('coffee', 11, kitchenY, 1, 1);
  item('table', 14, kitchenY - 2, 3, 2);
  item('sofa', 17, southTop + 5, 3, 1);
  plant(1, southTop + 1);
  plant(LOUNGE_W - 2, southTop + 1);
  plant(LOUNGE_W - 2, kitchenY);
  const standTiles: Pt[] = [];
  for (let x = 3; x <= 11; x += 2) for (const y of [kitchenY - 2, kitchenY - 1]) standTiles.push({ x, y });
  for (let x = 17; x <= 19; x++) for (const y of [kitchenY - 2, kitchenY - 1]) standTiles.push({ x, y });
  standTiles.push({ x: 13, y: kitchenY - 1 }, { x: 13, y: kitchenY - 2 });
  const stands: Seat[] = standTiles.map((t) => ({ tile: t, px: tileFeet(t) }));

  return {
    w,
    h,
    tiles,
    tint,
    rooms,
    lounge: { x0: 0, y0: southTop, w: LOUNGE_W, h: BOX_H, nooks, stands },
    lobby: { x0: 0, y0: 0, w: LOBBY_W, h: BOX_H, elevator, spawn: { x: elevator.x, y: elevator.y + elevator.h } },
    decor,
    hallway: { y0: hallY0, y1: hallY0 + HALL_H - 1 },
  };
}
