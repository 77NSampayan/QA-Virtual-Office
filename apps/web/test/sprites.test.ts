/**
 * C1: every status renders its specified animation and colour. Sprites are pure pixel grids, so
 * these tests measure the actual pixels (no browser needed) and a committed snapshot of every
 * sprite frame guards against accidental visual changes.
 * C2 (code check): sprite code must not use randomness or clocks.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_STATUSES, ROBOT_TYPES, ROBOT_TYPE_INFO, STATUS_ANIMATION, STATUS_COLOR, type RobotStatus, type RobotType } from '@qavo/shared';
import { gridEquals, gridSignature, WHITE, type Grid } from '../src/sprites/grid.ts';
import { drawGrid } from '../src/sprites/draw.ts';
import { renderDrone, DRONE_H, DRONE_W } from '../src/sprites/drone.ts';
import { FRAME_COUNT, LAYOUT, renderRobot, ROBOT_H, ROBOT_W } from '../src/sprites/robot.ts';
import { NOOK_H, NOOK_KINDS, NOOK_W, nookForRobot, renderNookBack, renderNookFront } from '../src/sprites/nook.ts';
import { renderStation, SCREEN, STATION_H, STATION_W } from '../src/sprites/station.ts';

const palette = { primary: '#6f7fe8', accent: '#ffd54a' };
const robot = (status: RobotStatus, frame: number, type: RobotType = 'qa_analyst', pal = palette) => renderRobot({ type, status, palette: pal, frame });
const station = (status: RobotStatus, frame: number, type: RobotType = 'qa_analyst') => renderStation({ type, status, palette, frame });
const frames = (status: RobotStatus) => Array.from({ length: FRAME_COUNT }, (_, f) => robot(status, f));

function pixels(g: Grid, region?: { x0: number; y0: number; x1: number; y1: number }): Array<{ x: number; y: number; c: string }> {
  const out: Array<{ x: number; y: number; c: string }> = [];
  g.forEach((row, y) =>
    row.forEach((c, x) => {
      if (c && (!region || (x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1))) out.push({ x, y, c });
    }),
  );
  return out;
}
const count = (g: Grid, color: string, region?: Parameters<typeof pixels>[1]) => pixels(g, region).filter((p) => p.c === color).length;
const FACE = { x0: LAYOUT.face.x, y0: LAYOUT.face.y, x1: LAYOUT.face.x + LAYOUT.face.w - 1, y1: LAYOUT.face.y + LAYOUT.face.h - 1 };
const distinct = (gs: Grid[]) => new Set(gs.map(gridSignature)).size;

describe('sprite basics', () => {
  it('the specification lists 10 statuses, each with a colour and an animation', () => {
    expect(ALL_STATUSES).toHaveLength(10);
    for (const s of ALL_STATUSES) {
      expect(STATUS_COLOR[s]).toMatch(/^#[0-9a-f]{6}$/);
      expect(STATUS_ANIMATION[s].length).toBeGreaterThan(5);
    }
    expect(new Set(Object.values(STATUS_COLOR)).size).toBe(10); // all distinct
  });

  it('renders 24x24 robots, 32x16 stations and 10x8 drones, deterministically, for every type/status/frame', () => {
    for (const type of ROBOT_TYPES) {
      for (const status of ALL_STATUSES) {
        for (let f = 0; f < FRAME_COUNT; f++) {
          const a = robot(status, f, type);
          expect(a).toHaveLength(ROBOT_H);
          expect(a[0]).toHaveLength(ROBOT_W);
          expect(pixels(a).length).toBeGreaterThan(80);
          expect(gridEquals(a, robot(status, f, type))).toBe(true);
          const s = station(status, f, type);
          expect(s).toHaveLength(STATION_H);
          expect(s[0]).toHaveLength(STATION_W);
        }
      }
    }
    const d = renderDrone({ status: 'analyzing', frame: 0 });
    expect([d.length, d[0]!.length]).toEqual([DRONE_H, DRONE_W]);
  });

  it('frame index wraps (continuous animation)', () => {
    expect(gridEquals(robot('analyzing', 1), robot('analyzing', 1 + FRAME_COUNT))).toBe(true);
    expect(gridEquals(robot('analyzing', 0), robot('analyzing', -FRAME_COUNT))).toBe(true);
  });

  it('drawGrid paints exactly the non-empty pixels at the given scale', () => {
    const calls: Array<[string, number, number, number, number]> = [];
    const ctx = {
      fillStyle: '',
      clearRect: () => undefined,
      fillRect(x: number, y: number, w: number, h: number) {
        calls.push([this.fillStyle, x, y, w, h]);
      },
    };
    const g = robot('idle', 0);
    drawGrid(ctx as unknown as CanvasRenderingContext2D, g, 3);
    expect(calls).toHaveLength(pixels(g).length);
    expect(calls.every(([, , , w, h]) => w === 3 && h === 3)).toBe(true);
  });
});

describe('C1: status colour', () => {
  it.each(ALL_STATUSES.filter((s) => s !== 'disconnected'))('%s shows its specified colour on the face LEDs and chest light', (status) => {
    for (let f = 0; f < FRAME_COUNT; f++) {
      const g = robot(status, f);
      expect(count(g, STATUS_COLOR[status], FACE), `${status} f${f} face`).toBeGreaterThan(0);
    }
    expect(count(robot(status, 0), STATUS_COLOR[status], { x0: 11, y0: 16, x1: 12, y1: 16 })).toBe(2);
  });

  it('disconnected is powered off: dim LEDs, no bright status colour anywhere', () => {
    const bright = ALL_STATUSES.filter((s) => s !== 'disconnected').map((s) => STATUS_COLOR[s]);
    for (let f = 0; f < FRAME_COUNT; f++) {
      const g = robot('disconnected', f);
      for (const p of pixels(g)) expect(bright, `pixel ${p.x},${p.y}`).not.toContain(p.c);
      for (const p of pixels(station('disconnected', f))) expect(bright).not.toContain(p.c);
    }
  });

  it('the robot body uses the chosen palette (and a different palette gives a different sprite)', () => {
    const g = robot('idle', 0);
    expect(count(g, palette.primary)).toBeGreaterThan(20);
    expect(count(g, palette.accent)).toBeGreaterThan(3);
    const other = robot('idle', 0, 'qa_analyst', { primary: '#11aa44', accent: '#aa11cc' });
    expect(count(other, '#11aa44')).toBeGreaterThan(20);
    expect(count(other, palette.primary)).toBe(0);
    expect(gridEquals(g, other)).toBe(false);
  });
});

describe('C1: status animations (as specified)', () => {
  it('every status is animated: at least two distinct frames', () => {
    for (const s of ALL_STATUSES) expect(distinct(frames(s)), s).toBeGreaterThanOrEqual(2);
  });

  it('idle: standing still, then blinking', () => {
    const f = frames('idle');
    expect(gridEquals(f[0]!, f[1]!)).toBe(true);
    expect(gridEquals(f[1]!, f[2]!)).toBe(true);
    expect(count(f[3]!, STATUS_COLOR.idle, FACE)).toBeLessThan(count(f[0]!, STATUS_COLOR.idle, FACE)); // eyes closed
  });

  it('analyzing: scans a document (eyes sweep, scan line travels down the page)', () => {
    const f = frames('analyzing');
    const minX = (g: Grid) => Math.min(...pixels(g, FACE).filter((p) => p.c === STATUS_COLOR.analyzing).map((p) => p.x));
    expect(minX(f[0]!)).toBeLessThan(minX(f[1]!));
    expect(minX(f[2]!)).toBeGreaterThan(minX(f[1]!));
    const doc = { x0: 0, y0: 11, x1: 4, y1: 18 };
    expect(pixels(f[0]!, doc).length).toBeGreaterThanOrEqual(40); // a 5x8 page is held
    expect(count(f[0]!, WHITE, doc)).toBeGreaterThan(0);
    const scanRow = (g: Grid) => pixels(g, doc).find((p) => p.c === STATUS_COLOR.analyzing)!.y;
    expect(new Set(f.map(scanRow)).size).toBeGreaterThanOrEqual(3);
  });

  it('writing_tests: types on the workstation (hands alternate, screen text grows)', () => {
    const f = frames('writing_tests');
    const arms = { x0: 4, y0: 14, x1: 19, y1: 21 };
    expect(gridSignature(f[0]!.map((r) => r.slice(0)))).not.toBe(gridSignature(f[1]!));
    expect(pixels(f[0]!, arms).length).not.toBe(0);
    const lowest = (g: Grid, x: number) => Math.max(...pixels(g, { x0: x, y0: 14, x1: x + 1, y1: 21 }).map((p) => p.y));
    expect(lowest(f[0]!, 5)).not.toBe(lowest(f[1]!, 5)); // left hand up/down
    expect(lowest(f[0]!, 17)).not.toBe(lowest(f[1]!, 17)); // right hand down/up
    const s = [0, 1, 2, 3].map((i) => station('writing_tests', i));
    expect(distinct(s)).toBeGreaterThanOrEqual(3); // typing on the screen
    for (const g of s) expect(count(g, STATUS_COLOR.writing_tests, { x0: SCREEN.x, y0: SCREEN.y, x1: SCREEN.x + SCREEN.w, y1: SCREEN.y + SCREEN.h })).toBeGreaterThan(0);
  });

  it('executing_tests: operates testing equipment (a lever moves, a progress bar fills)', () => {
    const f = frames('executing_tests');
    const lever = (g: Grid) => pixels(g, { x0: 19, y0: 13, x1: 23, y1: 15 }).filter((p) => p.c === STATUS_COLOR.executing_tests).map((p) => p.x)[0]!;
    expect(new Set(f.map(lever)).size).toBeGreaterThanOrEqual(3);
    expect(count(f[0]!, '#222a3d', { x0: 19, y0: 12, x1: 23, y1: 20 })).toBeGreaterThan(10); // the device
    const bar = (i: number) => count(station('executing_tests', i), STATUS_COLOR.executing_tests, { x0: SCREEN.x, y0: SCREEN.y + 2, x1: SCREEN.x + SCREEN.w, y1: SCREEN.y + 2 });
    expect(bar(3)).toBeGreaterThan(bar(0));
  });

  it('debugging: inspects a computer with a moving magnifier', () => {
    const f = frames('debugging');
    const rimTop = (g: Grid) => Math.min(...pixels(g, { x0: 17, y0: 8, x1: 23, y1: 17 }).filter((p) => p.c === WHITE).map((p) => p.y));
    expect(new Set(f.map(rimTop)).size).toBeGreaterThanOrEqual(3);
    const errLine = (i: number) => pixels(station('debugging', i), { x0: SCREEN.x, y0: SCREEN.y, x1: SCREEN.x + SCREEN.w, y1: SCREEN.y + SCREEN.h }).filter((p) => p.c === STATUS_COLOR.debugging)[0]!.y;
    expect(new Set([0, 1, 2].map(errLine)).size).toBe(3);
  });

  it('awaiting_permission: raises a hand and flashes a light', () => {
    const f = frames('awaiting_permission');
    const handRegion = { x0: 17, y0: 4, x1: 19, y1: 8 }; // right of the head, above the shoulder
    for (const g of f) expect(pixels(g, handRegion).length).toBeGreaterThan(4); // raised hand and arm
    expect(pixels(robot('idle', 0), handRegion).length).toBe(0);
    const beacon = { x0: LAYOUT.beacon.x, y0: LAYOUT.beacon.y, x1: LAYOUT.beacon.x + 1, y1: LAYOUT.beacon.y + 1 };
    const lit = f.map((g) => count(g, STATUS_COLOR.awaiting_permission, beacon));
    expect(lit).toEqual([4, 4, 0, 0]); // flashing
    expect(distinct(f)).toBe(4); // the light flashes and the hand waves, out of phase
  });

  it('awaiting_input: shows a question bubble', () => {
    for (let i = 0; i < FRAME_COUNT; i++) {
      const g = robot('awaiting_input', i);
      expect(count(g, WHITE, { x0: 14, y0: 0, x1: 22, y1: 7 })).toBeGreaterThan(20); // bubble outline
      expect(count(g, STATUS_COLOR.awaiting_input, { x0: 15, y0: 0, x1: 21, y1: 6 })).toBe(7); // the "?"
    }
    expect(count(robot('idle', 0), WHITE, { x0: 14, y0: 0, x1: 22, y1: 7 })).toBe(0);
  });

  it('completed: celebrates (arms up, hopping, sparkles)', () => {
    const f = frames('completed');
    const left = { x0: 4, y0: 6, x1: 6, y1: 12 }; // beside the head, above the shoulders
    const right = { x0: 17, y0: 6, x1: 19, y1: 12 };
    for (const g of f) {
      expect(pixels(g, left).length).toBeGreaterThan(6); // both arms raised
      expect(pixels(g, right).length).toBeGreaterThan(6);
    }
    expect(pixels(robot('idle', 0), left).length + pixels(robot('idle', 0), right).length).toBe(0);
    const headTop = (g: Grid) => Math.min(...pixels(g, { x0: 7, y0: 5, x1: 7, y1: 23 }).map((p) => p.y)); // top of the head outline (below the sparkle rows)
    expect(headTop(f[1]!)).toBeLessThan(headTop(f[0]!)); // hop
    const sparkle = (g: Grid) => gridSignature(g.slice(0, 7).map((r) => r.slice(0, 5).concat(r.slice(19))));
    expect(new Set(f.map(sparkle)).size).toBeGreaterThanOrEqual(3);
  });

  it('failed: error expression (X eyes) with sparks, in red', () => {
    const f = frames('failed');
    for (const g of f) {
      const red = pixels(g, FACE).filter((p) => p.c === STATUS_COLOR.failed).map((p) => `${p.x},${p.y}`);
      for (const xy of ['9,9', '11,9', '10,10', '9,11', '11,11', '12,9', '14,9', '13,10']) expect(red).toContain(xy);
    }
    expect(distinct(f)).toBe(4);
    expect(count(station('failed', 0), STATUS_COLOR.failed, { x0: SCREEN.x, y0: SCREEN.y, x1: SCREEN.x + SCREEN.w, y1: SCREEN.y + SCREEN.h })).toBeGreaterThanOrEqual(9);
  });

  it('disconnected: powered-off (dark face, standby light fading in and out)', () => {
    const f = frames('disconnected');
    expect(count(f[0]!, '#2a3042', FACE)).toBeGreaterThan(0);
    const standby = (g: Grid) => count(g, '#5d667b', { x0: 11, y0: 16, x1: 12, y1: 16 });
    expect([standby(f[0]!), standby(f[1]!)]).toEqual([2, 0]);
    expect(pixels(station('disconnected', 0), { x0: SCREEN.x, y0: SCREEN.y, x1: SCREEN.x + SCREEN.w - 1, y1: SCREEN.y + SCREEN.h - 1 }).every((p) => p.c === '#05070d')).toBe(true);
  });
});

describe('robot types and workstations', () => {
  it('the 7 robot types look different in every status', () => {
    for (const status of ALL_STATUSES) expect(distinct(ROBOT_TYPES.map((t) => robot(status, 0, t))), status).toBe(7);
  });
  it('the 7 workstations look different in every status', () => {
    for (const status of ALL_STATUSES) expect(distinct(ROBOT_TYPES.map((t) => station(status, 0, t))), status).toBe(7);
  });
  it('every type has a label, specialty, workstation and department', () => {
    expect(ROBOT_TYPES.map((t) => ROBOT_TYPE_INFO[t].workstation)).toEqual(
      expect.arrayContaining(['Requirements terminal', 'Testing workstation', 'Development workstation', 'API monitoring terminal', 'Test execution station', 'Debugging workstation', 'Central control desk']),
    );
  });
  it('drones animate and reflect status', () => {
    expect(distinct([0, 1, 2, 3].map((f) => renderDrone({ status: 'analyzing', frame: f })))).toBeGreaterThanOrEqual(2);
    expect(count(renderDrone({ status: 'debugging', frame: 0 }), STATUS_COLOR.debugging)).toBeGreaterThan(0);
  });
});

describe('lounge furniture', () => {
  const nook = (kind: (typeof NOOK_KINDS)[number], frame: number) => ({ back: renderNookBack({ kind, palette, frame }), front: renderNookFront({ kind, palette, frame }) });

  it('renders 32x16 layers deterministically for every kind and frame, and wraps the frame index', () => {
    for (const kind of NOOK_KINDS) {
      for (let f = 0; f < FRAME_COUNT; f++) {
        const n = nook(kind, f);
        for (const g of [n.back, n.front]) {
          expect(g).toHaveLength(NOOK_H);
          expect(g[0]).toHaveLength(NOOK_W);
        }
        expect(pixels(n.back).length + pixels(n.front).length).toBeGreaterThan(60); // some pieces draw mostly in front (ping-pong table)
        expect(gridEquals(n.back, nook(kind, f).back)).toBe(true);
        expect(gridEquals(n.back, nook(kind, f + FRAME_COUNT).back)).toBe(true);
      }
    }
  });

  it('the couch and the coffee counter have a foreground that covers the robot; the arcade does not', () => {
    expect(pixels(nook('couch', 0).front).length).toBeGreaterThan(40);
    expect(pixels(nook('coffee', 0).front).length).toBeGreaterThan(40);
    expect(pixels(nook('pingpong', 0).front).length).toBeGreaterThan(40);
    expect(pixels(nook('arcade', 0).front)).toHaveLength(0);
    expect(pixels(nook('tv', 0).front)).toHaveLength(0);
  });

  it('the furniture animates (steam, arcade and TV screens, the ping-pong ball) but the couch stays still', () => {
    expect(distinct(Array.from({ length: FRAME_COUNT }, (_, f) => nook('arcade', f).back))).toBeGreaterThan(1);
    expect(distinct(Array.from({ length: FRAME_COUNT }, (_, f) => nook('tv', f).back))).toBeGreaterThan(1);
    expect(distinct(Array.from({ length: FRAME_COUNT }, (_, f) => nook('pingpong', f).front))).toBeGreaterThan(1);
    expect(distinct(Array.from({ length: FRAME_COUNT }, (_, f) => nook('coffee', f).front))).toBeGreaterThan(1);
    expect(distinct(Array.from({ length: FRAME_COUNT }, (_, f) => nook('couch', f).back))).toBe(1);
  });

  it('a robot always rests at the same kind of furniture, and all kinds get used', () => {
    expect(nookForRobot('rb_abc')).toBe(nookForRobot('rb_abc'));
    const kinds = new Set(Array.from({ length: 60 }, (_, i) => nookForRobot(`robot-${i}`)));
    expect(kinds.size).toBe(NOOK_KINDS.length);
  });
});

describe('snapshot of every sprite frame', () => {
  const sig = (g: Grid) => createHash('sha1').update(gridSignature(g)).digest('hex').slice(0, 12);
  it('robots', () => {
    const out: Record<string, string> = {};
    for (const t of ROBOT_TYPES) for (const s of ALL_STATUSES) for (let f = 0; f < FRAME_COUNT; f++) out[`${t}/${s}/${f}`] = sig(robot(s, f, t));
    expect(out).toMatchSnapshot();
  });
  it('workstations', () => {
    const out: Record<string, string> = {};
    for (const t of ROBOT_TYPES) for (const s of ALL_STATUSES) for (let f = 0; f < FRAME_COUNT; f++) out[`${t}/${s}/${f}`] = sig(station(s, f, t));
    expect(out).toMatchSnapshot();
  });
  it('lounge furniture', () => {
    const out: Record<string, string> = {};
    for (const k of NOOK_KINDS) {
      for (let f = 0; f < FRAME_COUNT; f++) {
        out[`${k}/${f}/back`] = sig(renderNookBack({ kind: k, palette, frame: f }));
        out[`${k}/${f}/front`] = sig(renderNookFront({ kind: k, palette, frame: f }));
      }
    }
    expect(out).toMatchSnapshot();
  });
  it('drones', () => {
    const out: Record<string, string> = {};
    for (const s of ALL_STATUSES) for (let f = 0; f < FRAME_COUNT; f++) out[`${s}/${f}`] = sig(renderDrone({ status: s, frame: f }));
    expect(out).toMatchSnapshot();
  });
});

describe('C2 (code check): no client-side random or clock-driven activity in the visual layer', () => {
  const dirs = [path.resolve(__dirname, '../src/sprites')];
  const files = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(d, f)));
  it.each(files.map((f) => [path.basename(f), f] as const))('%s uses neither Math.random nor wall-clock time to decide what is shown', (_n, file) => {
    const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/Math\.random|crypto\.getRandomValues|Date\.now|new Date\(|performance\.now/);
  });
});

describe('slice 3: robot types differ in shape, not only in colour', () => {
  const mask = (g: Grid) => g.map((row) => row.map((c) => (c ? '#' : '.')).join('')).join('/');
  const grey = { primary: '#808080', accent: '#808080' }; // identical colours for every type: only the outline can tell them apart

  it('every pair of types has a different outline in every status and frame, with identical colours', () => {
    for (const status of ALL_STATUSES) {
      for (let f = 0; f < FRAME_COUNT; f++) {
        const seen = new Map<string, RobotType>();
        for (const type of ROBOT_TYPES) {
          const m = mask(robot(status, f, type, grey));
          expect(seen.get(m), `${type} looks like ${seen.get(m)} in ${status} frame ${f}`).toBeUndefined();
          seen.set(m, type);
        }
      }
    }
  });

  it('the outlines are not near-copies: any two types differ by at least 6 pixels when idle', () => {
    for (const a of ROBOT_TYPES) {
      for (const b of ROBOT_TYPES) {
        if (a >= b) continue;
        const ga = robot('idle', 0, a, grey);
        const gb = robot('idle', 0, b, grey);
        let diff = 0;
        ga.forEach((row, y) => row.forEach((c, x) => (!!c !== !!gb[y]![x] ? diff++ : 0)));
        expect(diff, `${a} vs ${b}`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('the face is the same for every type, so the real state reads the same way on every robot', () => {
    for (const status of ALL_STATUSES) {
      for (let f = 0; f < FRAME_COUNT; f++) {
        const faceOf = (type: RobotType) => pixels(robot(status, f, type, grey), FACE).filter((p) => p.c === STATUS_COLOR[status] || status === 'disconnected').map((p) => `${p.x},${p.y}`).join(';');
        const base = faceOf('qa_analyst');
        for (const type of ROBOT_TYPES) expect(faceOf(type), `${type} ${status} ${f}`).toBe(base);
      }
    }
  });

  it('a sprite never draws outside its 24x24 cell and always stands on the bottom row', () => {
    for (const type of ROBOT_TYPES) {
      const g = robot('idle', 0, type);
      expect(g).toHaveLength(ROBOT_H);
      expect(g.every((row) => row.length === ROBOT_W)).toBe(true);
      expect(g[ROBOT_H - 1]!.some((c) => c), `${type} touches the ground`).toBe(true);
    }
  });
});
