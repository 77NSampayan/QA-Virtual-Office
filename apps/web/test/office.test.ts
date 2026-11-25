/**
 * V1: the walkable office. Pure-logic tests (no browser): the building generator, pathfinding, camera
 * maths and the scene model. The scene must place robots by REAL status only and move them only when a
 * target changes ("no movement without an event").
 */
import { describe, expect, it } from 'vitest';
import type { RobotStatus } from '@qavo/shared';
import { clampZoom, fitCamera, fitRect, followStep, MAX_ZOOM, MIN_ZOOM, panBy, screenToWorld, worldToScreen, zoomAt, type Camera } from '../src/office/camera.ts';
import { buildOffice, isWalkable, roomCols, roomKeyForType, tileAt, TILE, type OfficeMap } from '../src/office/map.ts';
import { findPath } from '../src/office/path.ts';
import { CHAT_DISTANCE_PX, DOOR_RADIUS_PX, EFFECT_SECONDS, LIFT_OPEN_SECONDS, OfficeScene, WALK_TILES_PER_SEC, type RobotInput } from '../src/office/scene.ts';

const WALL_KINDS = ['board', 'wallscreen', 'statusboard', 'apimon', 'pipewall', 'invboard', 'warn'];
const palette = { primary: '#6f7fe8', accent: '#ffd54a' };
const spec = (key: string, robots = 0) => ({ key, label: key.toUpperCase(), robots });
const robot = (id: string, status: RobotStatus, roomKey = 'qa'): RobotInput => ({ id, name: id, status, roomKey, type: 'manual_tester', palette });
const sceneWith = (specs = [spec('qa', 4), spec('api', 2)]) => new OfficeScene(buildOffice(specs));
const run = (s: OfficeScene, seconds: number, dt = 0.05) => {
  for (let t = 0; t < seconds; t += dt) s.tick(dt);
};

describe('building generator', () => {
  it('always builds the same functional rooms, in order; the last one is kept free for later', () => {
    const m = buildOffice([]);
    expect(m.rooms.map((r) => r.key)).toEqual(['qa', 'automation', 'api', 'debug', 'cicd', 'expansion']);
    expect(m.rooms.filter((r) => r.vacant).map((r) => r.key)).toEqual(['expansion']);
    expect(m.rooms.every((r) => r.label.length > 0)).toBe(true);
    expect(buildOffice([spec('qa', 30)]).rooms.map((r) => r.key)).toEqual(m.rooms.map((r) => r.key));
  });

  it('a robot goes to the room of the type its owner chose; unknown types go to the QA Team room', () => {
    expect(roomKeyForType('manual_tester')).toBe('qa');
    expect(roomKeyForType('qa_analyst')).toBe('qa');
    expect(roomKeyForType('regression_tester')).toBe('qa');
    expect(roomKeyForType('qa_lead')).toBe('qa');
    expect(roomKeyForType('automation_engineer')).toBe('automation');
    expect(roomKeyForType('api_tester')).toBe('api');
    expect(roomKeyForType('bug_investigator')).toBe('debug');
    expect(roomKeyForType('ci_operator')).toBe('cicd');
    expect(roomKeyForType('something_old')).toBe('qa');
  });

  it('has two rows of rooms around a narrow hallway; lobby, lounge and rooms stay inside the map and the rows end together', () => {
    const m = buildOffice([spec('qa', 9), spec('api', 3)]);
    expect(m.rooms.filter((r) => r.side === 'north').map((r) => r.key)).toEqual(['qa', 'automation', 'api']);
    expect(m.rooms.filter((r) => r.side === 'south').map((r) => r.key)).toEqual(['debug', 'cicd', 'expansion']);
    expect(m.hallway.y1 - m.hallway.y0 + 1).toBe(2);
    for (const r of m.rooms) {
      expect(r.x0 + r.w).toBeLessThanOrEqual(m.w);
      expect(r.y0 + r.h).toBeLessThanOrEqual(m.h);
    }
    for (const side of ['north', 'south'] as const) {
      const last = m.rooms.filter((r) => r.side === side).at(-1)!;
      expect(last.x0 + last.w).toBe(m.w);
    }
    expect(m.lobby.y0 + m.lobby.h).toBe(m.hallway.y0);
    expect(m.lounge.y0).toBe(m.hallway.y1 + 1);
    expect(m.w).toBeLessThan(80);
    expect(m.h).toBeLessThan(34);
  });

  it('room capacity follows the robot count: 2 desks per column, with a minimum per room', () => {
    expect(roomCols(0, 3)).toBe(3);
    expect(roomCols(7, 3)).toBe(4);
    expect(roomCols(9, 5)).toBe(5);
    const m = buildOffice([spec('qa', 13), spec('automation', 1)]);
    const by = (k: string) => m.rooms.find((r) => r.key === k)!;
    expect(by('qa').desks).toHaveLength(14);
    expect(by('automation').desks).toHaveLength(6);
    expect(by('expansion').desks).toHaveLength(0);
  });

  it('every floor item blocks walking; every seat, door, nook and standing spot is walkable and reachable from the elevator', () => {
    const m = buildOffice([spec('qa', 12), spec('automation', 4), spec('api', 8), spec('debug', 3), spec('cicd', 2)]);
    const spawn = m.lobby.spawn;
    expect(isWalkable(m, spawn.x, spawn.y)).toBe(true);
    const targets = [...m.rooms.flatMap((r) => r.desks.map((d) => d.tile)), ...m.rooms.flatMap((r) => r.door), ...m.lounge.nooks.map((n) => n.tile), ...m.lounge.stands.map((s) => s.tile)];
    expect(targets.length).toBeGreaterThan(40);
    for (const t of targets) {
      expect(isWalkable(m, t.x, t.y), `walkable ${t.x},${t.y}`).toBe(true);
      expect(findPath(m, spawn, t), `reachable ${t.x},${t.y}`).not.toBeNull();
    }
    for (const r of m.rooms) for (const d of r.desks) expect(isWalkable(m, d.desk.x, d.desk.y)).toBe(false);
    for (const n of m.lounge.nooks) expect(isWalkable(m, n.nook.x, n.nook.y)).toBe(false);
    expect(tileAt(m, -1, 0)).toBe('void');
    expect(isWalkable(m, m.lobby.elevator.x, m.lobby.elevator.y)).toBe(false);
    // floor items (not wall displays) are solid and do not sit on top of one another
    const seen = new Set<string>();
    for (const d of m.decor.filter((x) => !WALL_KINDS.includes(x.kind))) {
      for (let y = d.y; y < d.y + d.h; y++) {
        for (let x = d.x; x < d.x + d.w; x++) {
          expect(isWalkable(m, x, y), `${d.kind} ${x},${y} blocks`).toBe(false);
          expect(seen.has(`${x},${y}`), `${d.kind} overlaps at ${x},${y}`).toBe(false);
          seen.add(`${x},${y}`);
        }
      }
    }
  });

  it('desks and furniture never overlap, and nothing stands on a seat tile or a doorway', () => {
    const m = buildOffice([spec('qa', 20), spec('automation', 9), spec('api', 9), spec('debug', 9), spec('cicd', 9)]);
    const taken = new Set<string>();
    for (const d of m.decor.filter((x) => !WALL_KINDS.includes(x.kind))) for (let y = d.y; y < d.y + d.h; y++) for (let x = d.x; x < d.x + d.w; x++) taken.add(`${x},${y}`);
    for (const r of m.rooms) {
      const seen = new Set<string>();
      for (const d of r.desks) {
        for (const x of [d.desk.x, d.desk.x + 1]) {
          const k = `${x},${d.desk.y}`;
          expect(seen.has(k)).toBe(false);
          expect(taken.has(k), `desk on furniture ${k}`).toBe(false);
          seen.add(k);
        }
        expect(taken.has(`${d.tile.x},${d.tile.y}`)).toBe(false);
        expect(d.tile).toEqual({ x: d.desk.x, y: d.desk.y - 1 });
        expect(d.px).toEqual({ x: (d.desk.x + 1) * TILE, y: d.desk.y * TILE + 7 });
      }
      for (const t of r.door) expect(taken.has(`${t.x},${t.y}`)).toBe(false);
    }
  });

  it('wall displays sit on a wall, clear of every doorway and of the windows', () => {
    const m = buildOffice([]);
    for (const d of m.decor.filter((x) => WALL_KINDS.includes(x.kind))) {
      for (let x = d.x; x < d.x + d.w; x++) {
        expect(tileAt(m, x, d.y), `${d.kind} at ${x},${d.y}`).toBe('wall');
        expect(m.rooms.some((r) => r.door.some((t) => t.x === x && t.y === d.y))).toBe(false);
        for (const r of m.rooms) for (const wx of r.windows) expect(x >= wx && x < wx + 2 && d.y === 0, `${d.kind} over a window at ${x}`).toBe(false);
      }
    }
    for (const r of m.rooms) {
      if (r.side === 'south') expect(r.windows).toEqual([]);
      for (const x of r.windows) {
        expect(x).toBeGreaterThan(r.x0);
        expect(x + 2).toBeLessThan(r.x0 + r.w);
      }
    }
  });

  it('the lounge has 8 nooks covering all five kinds of furniture, a kitchen, and room to stand', () => {
    const m = buildOffice([]);
    expect(m.lounge.nooks).toHaveLength(8);
    expect(new Set(m.lounge.nooks.map((n) => n.kind))).toEqual(new Set(['couch', 'coffee', 'arcade', 'tv', 'pingpong']));
    expect(m.lounge.stands.length).toBeGreaterThanOrEqual(12);
    for (const k of ['fridge', 'counter', 'coffee', 'table', 'sofa']) expect(m.decor.some((d) => d.kind === k && d.y >= m.lounge.y0), k).toBe(true);
  });
});

describe('pathfinding', () => {
  const m: OfficeMap = buildOffice([spec('qa', 4), spec('automation', 4)]);
  it('finds a route made only of adjacent walkable tiles, ending on the target', () => {
    const to = m.rooms[1]!.desks[3]!.tile;
    const path = findPath(m, m.lobby.spawn, to)!;
    expect(path.at(-1)).toEqual(to);
    let prev = m.lobby.spawn;
    for (const p of path) {
      expect(Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y)).toBe(1);
      expect(isWalkable(m, p.x, p.y)).toBe(true);
      prev = p;
    }
  });
  it('is deterministic, empty when already there, and null for walls or unreachable tiles', () => {
    const to = m.lounge.stands[0]!.tile;
    expect(findPath(m, m.lobby.spawn, to)).toEqual(findPath(m, m.lobby.spawn, to));
    expect(findPath(m, to, to)).toEqual([]);
    expect(findPath(m, m.lobby.spawn, { x: 0, y: 0 })).toBeNull();
    expect(findPath(m, m.lobby.spawn, m.rooms[0]!.desks[0]!.desk)).toBeNull();
  });
  it('a route between two rooms goes through the hallway (door -> hall -> door)', () => {
    const a = m.rooms[0]!.desks[0]!.tile;
    const b = m.rooms[1]!.desks[0]!.tile;
    const kinds = findPath(m, a, b)!.map((p) => tileAt(m, p.x, p.y));
    expect(kinds.filter((k) => k === 'door').length).toBeGreaterThanOrEqual(2); // out of one room and into the other
    expect(kinds).toContain('hall');
  });
});

describe('camera', () => {
  const view = { w: 800, h: 500 };
  const world = { w: 600, h: 400 };
  const cam: Camera = { x: 300, y: 200, zoom: 2 };
  it('zooming keeps the world point under the cursor fixed, and clamps the zoom', () => {
    const before = screenToWorld(cam, view, 250, 120);
    const next = zoomAt(cam, view, world, 1.5, 250, 120);
    const after = screenToWorld(next, view, 250, 120);
    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
    expect(zoomAt(cam, view, world, 1000, 400, 250).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(cam, view, world, 0.0001, 400, 250).zoom).toBe(MIN_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
  });
  it('dragging pans the scene with the pointer and never leaves the world', () => {
    const p = panBy(cam, world, 100, 50);
    expect(p.x).toBeCloseTo(300 - 50);
    expect(p.y).toBeCloseTo(200 - 25);
    expect(panBy(cam, world, -100000, -100000)).toMatchObject({ x: 600, y: 400 });
    expect(panBy(cam, world, 100000, 100000)).toMatchObject({ x: 0, y: 0 });
  });
  it('world and screen coordinates convert both ways; fit shows the whole office', () => {
    const s = worldToScreen(cam, view, 123, 77);
    const w = screenToWorld(cam, view, s.x, s.y);
    expect(w.x).toBeCloseTo(123);
    expect(w.y).toBeCloseTo(77);
    const f = fitCamera(view, world);
    expect(f.x).toBe(300);
    expect(f.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(world.w * f.zoom).toBeLessThanOrEqual(view.w);
    expect(world.h * f.zoom).toBeLessThanOrEqual(view.h);
  });
  it('following eases towards the target (instantly when motion is reduced) without changing the zoom', () => {
    const step = followStep(cam, { x: 400, y: 300 }, 0.1, false);
    expect(step.x).toBeGreaterThan(300);
    expect(step.x).toBeLessThan(400);
    expect(step.zoom).toBe(2);
    expect(followStep(cam, { x: 400, y: 300 }, 0.1, true)).toMatchObject({ x: 400, y: 300 });
  });
});

describe('scene: who is where follows real status', () => {
  it('on the first sync robots are simply placed: resting ones in the lounge, everyone else at their desk, nobody walks', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'idle'), robot('r2', 'completed'), robot('r3', 'analyzing'), robot('r4', 'awaiting_permission'), robot('r5', 'failed'), robot('r6', 'disconnected', 'api')]);
    const z = Object.fromEntries(s.snapshot().map((a) => [a.id, a.zone]));
    expect(z).toEqual({ r1: 'lounge', r2: 'lounge', r3: 'desk', r4: 'desk', r5: 'desk', r6: 'desk' });
    expect(s.isWalking()).toBe(false);
  });

  it('desks are unique per room and stay with the robot', () => {
    const s = sceneWith([spec('qa', 4), spec('api', 2)]);
    s.sync([robot('a', 'analyzing'), robot('b', 'analyzing'), robot('c', 'analyzing'), robot('d', 'analyzing'), robot('e', 'analyzing', 'api')]);
    const seats = [...s.actors.values()].map((a) => a.goal.key);
    expect(new Set(seats).size).toBe(seats.length);
    const homeOfA = s.actors.get('a')!.goal.key;
    s.sync([robot('a', 'idle'), robot('b', 'analyzing'), robot('c', 'analyzing'), robot('d', 'analyzing'), robot('e', 'analyzing', 'api')]);
    run(s, 30);
    expect(s.actors.get('a')!.zone).toBe('lounge');
    s.sync([robot('a', 'analyzing'), robot('b', 'analyzing'), robot('c', 'analyzing'), robot('d', 'analyzing'), robot('e', 'analyzing', 'api')]);
    run(s, 30);
    expect(s.actors.get('a')!.goal.key).toBe(homeOfA); // back at the very same desk
    expect(s.actors.get('a')!.zone).toBe('desk');
  });

  it('a robot that goes idle WALKS to the lounge (visible walking), arrives, and walks back when work resumes', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'analyzing')]);
    const desk = { ...s.actors.get('r1')! };
    s.sync([robot('r1', 'idle')]);
    expect(s.actors.get('r1')!.zone).toBe('walking');
    expect(s.isWalking()).toBe(true);
    run(s, 0.5);
    expect(s.actors.get('r1')!.zone).toBe('walking');
    expect(Math.hypot(s.actors.get('r1')!.x - desk.x, s.actors.get('r1')!.y - desk.y)).toBeGreaterThan(8);
    run(s, 40);
    expect(s.actors.get('r1')!.zone).toBe('lounge');
    expect(s.isWalking()).toBe(false);
    s.sync([robot('r1', 'executing_tests')]);
    expect(s.actors.get('r1')!.zone).toBe('walking');
    run(s, 40);
    expect(s.actors.get('r1')).toMatchObject({ zone: 'desk', x: desk.x, y: desk.y });
  });

  it('NOTHING MOVES without an event: ticking and re-syncing identical states changes nothing', () => {
    const s = sceneWith();
    const inputs = [robot('r1', 'idle'), robot('r2', 'analyzing'), robot('r3', 'completed')];
    s.sync(inputs);
    const snap = () => JSON.stringify([...s.actors.values()].map((a) => [a.id, a.x, a.y, a.zone, a.waypoints.length]));
    const before = snap();
    const v = s.version;
    run(s, 120);
    s.sync(inputs);
    s.sync(inputs);
    run(s, 120);
    expect(snap()).toBe(before);
    expect(s.version).toBe(v);
    expect(s.isWalking()).toBe(false);
  });

  it('a robot that appears later arrives through the elevator, then settles at its place', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'analyzing')]);
    s.sync([robot('r1', 'analyzing'), robot('r2', 'analyzing')]);
    const a = s.actors.get('r2')!;
    const spawn = s.map.lobby.spawn;
    expect(a.zone).toBe('walking');
    expect(Math.floor(a.x / TILE)).toBe(spawn.x);
    expect(Math.floor(a.y / TILE)).toBe(spawn.y);
    run(s, 60);
    expect(a.zone).toBe('desk');
    expect(a.x).toBe(a.goal.seat.px.x);
  });

  it('never walks through walls or desks (every waypoint before the last seat step is walkable)', () => {
    const s = sceneWith([spec('qa', 6), spec('api', 4)]);
    s.sync([robot('r1', 'analyzing', 'qa'), robot('r2', 'idle', 'api')]);
    s.sync([robot('r1', 'idle', 'qa'), robot('r2', 'analyzing', 'api')]);
    let guard = 0;
    while (s.isWalking() && guard++ < 4000) {
      for (const a of s.actors.values()) {
        const rest = a.waypoints.slice(0, -1);
        for (const w of rest) expect(isWalkable(s.map, Math.floor(w.x / TILE), Math.floor(w.y / TILE))).toBe(true);
      }
      s.tick(0.05);
    }
    expect(s.isWalking()).toBe(false);
  });

  it('walks at the documented speed', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'analyzing')]);
    s.sync([robot('r1', 'idle')]);
    const a = s.actors.get('r1')!;
    const x0 = a.x;
    const y0 = a.y;
    s.tick(0.1);
    expect(Math.hypot(a.x - x0, a.y - y0)).toBeLessThanOrEqual(WALK_TILES_PER_SEC * TILE * 0.1 + 0.001);
    expect(Math.hypot(a.x - x0, a.y - y0)).toBeGreaterThan(1);
  });

  it('reduced motion: targets are reached instantly, no walking, arrivals appear in place', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'analyzing')], { reducedMotion: true });
    s.sync([robot('r1', 'idle'), robot('r2', 'analyzing')], { reducedMotion: true });
    expect(s.isWalking()).toBe(false);
    expect(s.actors.get('r1')!.zone).toBe('lounge');
    expect(s.actors.get('r2')!.zone).toBe('desk');
  });

  it('lounge spots: a robot prefers its own kind of furniture, spots are not shared, and overflow stands around', () => {
    const s = sceneWith();
    const many = Array.from({ length: 12 }, (_, i) => robot(`rest-${i}`, 'idle'));
    s.sync(many);
    const keys = [...s.actors.values()].map((a) => a.goal.key);
    expect(new Set(keys).size).toBe(12);
    expect(keys.filter((k) => k.startsWith('lounge:nook:'))).toHaveLength(8);
    expect(keys.filter((k) => k.startsWith('lounge:stand:'))).toHaveLength(4);
  });

  it('is deterministic: the same events give the same positions', () => {
    const play = () => {
      const s = sceneWith();
      s.sync([robot('r1', 'analyzing'), robot('r2', 'idle')]);
      s.sync([robot('r1', 'idle'), robot('r2', 'analyzing')]);
      run(s, 3);
      return JSON.stringify([...s.actors.values()].map((a) => [a.id, a.x, a.y]));
    };
    expect(play()).toBe(play());
  });

  it('a robot that disappears frees its desk; a robot with an unknown room sits in the first real room', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'analyzing')]);
    const k = s.actors.get('r1')!.goal.key;
    s.sync([]);
    expect(s.actors.size).toBe(0);
    s.sync([robot('r2', 'analyzing', 'nowhere')]);
    expect(s.actors.get('r2')!.goal.key).toBe(k.replace(/:\d+$/, ':0'));
    run(s, 60); // arrives through the elevator, then sits at that desk
    expect(s.actors.get('r2')!.zone).toBe('desk');
  });

  it('a layout change re-seats robots in place instead of making them walk', () => {
    const s = sceneWith([spec('qa', 2), spec('api', 2)]);
    s.sync([robot('r1', 'analyzing'), robot('r2', 'idle')]);
    s.setMap(buildOffice([spec('qa', 10), spec('api', 2)]));
    expect(s.isWalking()).toBe(false);
    for (const a of s.actors.values()) expect(a.x).toBe(a.goal.seat.px.x);
  });
});

describe('scene V2: effects, drones, doors, lift, chat', () => {
  const withDrones = (r: RobotInput, ids: string[]): RobotInput => ({ ...r, drones: ids.map((agentId) => ({ agentId, agentType: 'Explore', status: 'analyzing' as RobotStatus })) });

  it('confetti on a REAL change to completed and a rain cloud on failed, each for a limited time', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'analyzing'), robot('r2', 'analyzing')]);
    expect(s.effects).toHaveLength(0); // first placement is not a celebration
    s.sync([robot('r1', 'completed'), robot('r2', 'failed')]);
    expect(s.effects.map((e) => `${e.actorId}:${e.kind}`).sort()).toEqual(['r1:confetti', 'r2:rain']);
    expect(s.effectsOf('r1')[0]!.dur).toBe(EFFECT_SECONDS.confetti);
    run(s, EFFECT_SECONDS.rain + 0.5);
    expect(s.effects).toHaveLength(0);
  });

  it('no celebration without a status change, on initial placement, or with reduced motion', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'completed')]);
    s.sync([robot('r1', 'completed')]);
    expect(s.effects).toHaveLength(0);
    s.sync([robot('r1', 'analyzing')]);
    s.sync([robot('r1', 'completed')], { initial: true });
    expect(s.effects).toHaveLength(0);
    s.sync([robot('r1', 'analyzing')]);
    s.sync([robot('r1', 'completed')], { reducedMotion: true });
    expect(s.effects).toHaveLength(0);
  });

  it('a removed robot takes its effects with it', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'analyzing')]);
    s.sync([robot('r1', 'completed')]);
    expect(s.effects).toHaveLength(1);
    s.sync([]);
    expect(s.effects).toHaveLength(0);
  });

  it('drones present at load hover beside their robot; later ones fly in from the elevator and then hover', () => {
    const s = sceneWith();
    s.sync([withDrones(robot('r1', 'analyzing'), ['d1'])]);
    const d1 = s.drones.get('r1:d1')!;
    expect(d1.arriving).toBe(false);
    s.sync([withDrones(robot('r1', 'analyzing'), ['d1', 'd2'])]);
    const d2 = s.drones.get('r1:d2')!;
    const f = s.map.lobby.spawn;
    expect(d2.arriving).toBe(true);
    expect(Math.floor(d2.x / TILE)).toBe(f.x);
    expect(s.isAnimating()).toBe(true);
    run(s, 20);
    expect(d2.arriving).toBe(false);
    const parent = s.actors.get('r1')!;
    expect(d2.x).toBeLessThan(parent.x); // hovers beside (to the left of) its robot
    expect(d2.x).not.toBe(d1.x);
  });

  it('drones follow a walking robot and disappear when the subagent ends', () => {
    const s = sceneWith();
    s.sync([withDrones(robot('r1', 'analyzing'), ['d1'])]);
    s.sync([withDrones(robot('r1', 'idle'), ['d1'])]);
    const before = s.drones.get('r1:d1')!.x;
    run(s, 40);
    const p = s.actors.get('r1')!;
    const d = s.drones.get('r1:d1')!;
    expect(Math.abs(d.x - (p.x - 15))).toBeLessThan(1);
    expect(d.x).not.toBe(before);
    s.sync([robot('r1', 'idle')]);
    expect(s.drones.size).toBe(0);
  });

  it('a room door opens only while someone is near it, and shuts again; vacant rooms stay shut', () => {
    const s = sceneWith([spec('qa', 4), spec('api', 2)]);
    s.sync([robot('r1', 'idle', 'qa')]);
    run(s, 1);
    expect(s.doorsOpen()).toEqual([]);
    s.sync([robot('r1', 'analyzing', 'qa')]); // walks from the lounge to its room
    const opened = new Set<string>();
    for (let t = 0; t < 40 && s.isWalking(); t += 0.05) {
      s.tick(0.05);
      for (const k of s.doorsOpen(0.5)) opened.add(k);
    }
    expect([...opened]).toContain('qa');
    run(s, 2);
    expect(s.doorsOpen()).toEqual([]);
    const vacant = sceneWith([spec('qa', 1)]);
    vacant.sync([robot('x', 'idle', 'qa')]);
    vacant.sync([robot('x', 'analyzing', 'qa')]);
    run(vacant, 40);
    for (const r of vacant.map.rooms.filter((r) => r.vacant)) expect(vacant.doors.get(r.key)!.open).toBe(0);
  });

  it('a door never opens for a robot far away', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'analyzing', 'qa')]);
    run(s, 3);
    const room = s.map.rooms.find((r) => r.key === 'api')!;
    const cx = (room.door[0]!.x + 1) * TILE;
    const cy = (room.door[0]!.y + 0.5) * TILE;
    const a = s.actors.get('r1')!;
    expect(Math.hypot(a.x - cx, a.y - cy)).toBeGreaterThan(DOOR_RADIUS_PX);
    expect(s.doors.get('api')!.open).toBe(0);
  });

  it('the elevator opens when a robot arrives and closes again', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'analyzing')]);
    s.sync([robot('r1', 'analyzing'), robot('r2', 'analyzing')]);
    s.tick(0.3);
    expect(s.lift.open).toBeGreaterThan(0);
    run(s, LIFT_OPEN_SECONDS + 2);
    expect(s.lift.open).toBe(0);
  });

  it('standing lounge robots next to each other are chatting; a lone one is not', () => {
    const s = sceneWith();
    const many = Array.from({ length: 11 }, (_, i) => robot(`rest-${i}`, 'idle'));
    s.sync(many);
    const chat = s.chatting();
    expect(chat.size).toBeGreaterThanOrEqual(2);
    for (const id of chat) expect(s.actors.get(id)!.goal.key.startsWith('lounge:stand:')).toBe(true);
    const one = sceneWith();
    one.sync([robot('solo', 'idle')]);
    expect(one.chatting().size).toBe(0);
    expect(CHAT_DISTANCE_PX).toBeGreaterThan(16);
  });

  it('NOTHING animates without an event: after settling, doors, drones, lift and effects are all still', () => {
    const s = sceneWith();
    s.sync([withDrones(robot('r1', 'analyzing'), ['d1']), robot('r2', 'idle')]);
    s.sync([withDrones(robot('r1', 'completed'), ['d1']), robot('r2', 'analyzing')]);
    run(s, 60);
    expect(s.isAnimating()).toBe(false);
    run(s, 60);
    expect(s.isAnimating()).toBe(false);
    expect(s.doorsOpen()).toEqual([]);
  });
});

describe('scene sound events (only for real changes)', () => {
  it('arrivals and real changes to completed, failed or "needs you" queue a sound; the queue is drained once', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'analyzing'), robot('r2', 'analyzing'), robot('r3', 'analyzing')]);
    expect(s.drainSounds()).toEqual([]); // first placement is silent
    s.sync([robot('r1', 'completed'), robot('r2', 'failed'), robot('r3', 'awaiting_permission')]);
    expect(s.drainSounds().sort()).toEqual(['alert', 'complete', 'fail']);
    expect(s.drainSounds()).toEqual([]);
    s.sync([robot('r1', 'completed'), robot('r2', 'failed'), robot('r3', 'awaiting_input')]);
    expect(s.drainSounds()).toEqual(['alert']);
    s.sync([robot('r1', 'completed'), robot('r2', 'failed'), robot('r3', 'awaiting_input'), robot('r4', 'idle')]);
    expect(s.drainSounds()).toEqual(['arrive']);
  });

  it('nothing is queued for identical syncs, working-state changes, initial loads, or ticking', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'analyzing')]);
    s.sync([robot('r1', 'analyzing')]);
    s.sync([robot('r1', 'writing_tests')]);
    s.sync([robot('r1', 'idle')]);
    run(s, 60);
    expect(s.drainSounds()).toEqual([]);
    s.sync([robot('r1', 'failed')], { initial: true });
    expect(s.drainSounds()).toEqual([]);
  });

  it('sounds are independent of reduced motion (that is about movement)', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'analyzing')], { reducedMotion: true });
    s.sync([robot('r1', 'completed')], { reducedMotion: true });
    expect(s.drainSounds()).toEqual(['complete']);
  });
});

describe('the QA Team room: every agent has its own desk', () => {
  const team = () => new OfficeScene(buildOffice([{ ...spec('qa', 9), reserved: 9 }]));
  const agent = (id: string, status: RobotStatus, deskIndex: number): RobotInput => ({ ...robot(id, status, 'team'), deskIndex });
  const deskOf = (s: OfficeScene, id: string) => s.actors.get(id)!.goal.key;

  it('seats each agent at the desk it was given, whatever order the robots arrive in', () => {
    const s = team();
    s.sync([agent('quinn', 'analyzing', 1), agent('rhea', 'analyzing', 2), agent('bram', 'analyzing', 7)], { initial: true });
    expect(deskOf(s, 'quinn')).toBe('desk:qa:1');
    expect(deskOf(s, 'rhea')).toBe('desk:qa:2');
    expect(deskOf(s, 'bram')).toBe('desk:qa:7');
    const s2 = team();
    s2.sync([agent('bram', 'analyzing', 7), agent('rhea', 'analyzing', 2), agent('quinn', 'analyzing', 1)], { initial: true });
    expect([deskOf(s2, 'quinn'), deskOf(s2, 'rhea'), deskOf(s2, 'bram')]).toEqual(['desk:qa:1', 'desk:qa:2', 'desk:qa:7']);
  });

  it('keeps empty desks empty (nobody is invented), and the team room has a desk for every role', () => {
    const s = team();
    const room = s.map.rooms.find((r) => r.key === 'qa')!;
    expect(room.vacant).toBe(false);
    expect(room.desks.length).toBeGreaterThanOrEqual(9);
    s.sync([agent('quinn', 'analyzing', 1)], { initial: true });
    expect(s.deskOwner('qa', 1)?.id).toBe('quinn');
    for (const i of [0, 2, 3, 4, 5, 6, 7, 8]) expect(s.deskOwner('qa', i)).toBeUndefined();
  });

  it('an agent at rest goes to the lounge, leaving its desk empty, and returns to the same desk when it works again', () => {
    const s = team();
    s.sync([agent('quinn', 'analyzing', 3)], { initial: true });
    s.sync([agent('quinn', 'completed', 3)]);
    run(s, 8);
    expect(s.actors.get('quinn')!.zone).toBe('lounge');
    s.sync([agent('quinn', 'analyzing', 3)]);
    run(s, 12);
    expect(s.actors.get('quinn')!.zone).toBe('desk');
    expect(deskOf(s, 'quinn')).toBe('desk:qa:3');
  });

  it('never moves without an event, and a taken desk falls back to a free one instead of sharing', () => {
    const s = team();
    s.sync([agent('quinn-a', 'analyzing', 1), agent('quinn-b', 'analyzing', 1)], { initial: true }); // the same agent on two projects
    expect(new Set([deskOf(s, 'quinn-a'), deskOf(s, 'quinn-b')]).size).toBe(2);
    const before = [...s.actors.values()].map((a) => [a.x, a.y]);
    run(s, 10);
    expect([...s.actors.values()].map((a) => [a.x, a.y])).toEqual(before);
    expect(s.isWalking()).toBe(false);
  });

  it('ordinary robots without a fixed desk never take a desk kept for a named agent', () => {
    const s = team();
    s.sync([robot('plain', 'analyzing', 'qa')], { initial: true });
    expect(deskOf(s, 'plain')).toBe('desk:qa:9'); // never a desk kept for a named agent
  });
});

describe('slice 2: framing what is in use', () => {
  it('fitRect centres a rectangle, fits it to the view and respects the zoom limits', () => {
    const world = { w: 1000, h: 500 };
    const c = fitRect({ w: 800, h: 400 }, { x: 100, y: 50, w: 400, h: 200 }, world, 0);
    expect(c.zoom).toBe(2);
    expect(c.x).toBe(300);
    expect(c.y).toBe(150);
    expect(fitRect({ w: 800, h: 400 }, { x: 0, y: 0, w: 10, h: 10 }, world).zoom).toBe(MAX_ZOOM);
    expect(fitRect({ w: 100, h: 100 }, { x: 0, y: 0, w: 5000, h: 5000 }, world).zoom).toBe(MIN_ZOOM);
  });

  it('occupancy lists rooms with a robot at a desk, and the lounge only when somebody is heading there', () => {
    const s = sceneWith([spec('qa', 4), spec('api', 2)]);
    expect(s.occupancy()).toEqual({ rooms: new Set(), lounge: false });
    s.sync([robot('a', 'analyzing', 'qa'), robot('b', 'analyzing', 'api')], { initial: true });
    expect(s.occupancy()).toEqual({ rooms: new Set(['qa', 'api']), lounge: false });
    s.sync([robot('a', 'idle', 'qa'), robot('b', 'analyzing', 'api')]);
    expect(s.occupancy()).toEqual({ rooms: new Set(['api']), lounge: true });
  });

  it('the whole building fits a small window (it is not cropped)', () => {
    const m = buildOffice([]);
    const world = { w: m.w * TILE, h: m.h * TILE };
    for (const view of [{ w: 800, h: 510 }, { w: 1000, h: 558 }]) {
      const f = fitCamera(view, world);
      expect(world.w * f.zoom).toBeLessThanOrEqual(view.w);
      expect(world.h * f.zoom).toBeLessThanOrEqual(view.h);
    }
  });
});
