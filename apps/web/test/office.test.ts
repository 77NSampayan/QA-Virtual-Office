/**
 * V1: the walkable office. Pure-logic tests (no browser): the building generator, pathfinding, camera
 * maths and the scene model. The scene must place robots by REAL status only and move them only when a
 * target changes ("no movement without an event").
 */
import { describe, expect, it } from 'vitest';
import type { RobotStatus } from '@qavo/shared';
import { clampZoom, fitCamera, followStep, MAX_ZOOM, MIN_ZOOM, panBy, screenToWorld, worldToScreen, zoomAt, type Camera } from '../src/office/camera.ts';
import { buildOffice, isWalkable, MIN_ROOMS, roomCols, tileAt, TILE, type OfficeMap } from '../src/office/map.ts';
import { findPath } from '../src/office/path.ts';
import { CHAT_DISTANCE_PX, DOOR_RADIUS_PX, EFFECT_SECONDS, LIFT_OPEN_SECONDS, OfficeScene, WALK_TILES_PER_SEC, type RobotInput } from '../src/office/scene.ts';

const palette = { primary: '#6f7fe8', accent: '#ffd54a' };
const spec = (key: string, robots = 0) => ({ key, label: key.toUpperCase(), robots });
const robot = (id: string, status: RobotStatus, roomKey = 'shop'): RobotInput => ({ id, name: id, status, roomKey, type: 'manual_tester', palette });
const sceneWith = (specs = [spec('shop', 4), spec('api', 2)]) => new OfficeScene(buildOffice(specs));
const run = (s: OfficeScene, seconds: number, dt = 0.05) => {
  for (let t = 0; t < seconds; t += dt) s.tick(dt);
};

describe('building generator', () => {
  it('always has at least two rooms and an even number (vacant rooms fill the gaps)', () => {
    expect(buildOffice([]).rooms).toHaveLength(MIN_ROOMS);
    expect(buildOffice([spec('a')]).rooms).toHaveLength(2);
    expect(buildOffice([spec('a'), spec('b'), spec('c')]).rooms).toHaveLength(4);
    expect(buildOffice([spec('a')]).rooms.filter((r) => r.vacant)).toHaveLength(1);
    expect(buildOffice([spec('a'), spec('b')]).rooms.every((r) => !r.vacant)).toBe(true);
  });

  it('puts rooms on both sides of one hallway, and rooms/lounge/lobby inside the map', () => {
    const m = buildOffice([spec('a', 3), spec('b', 3), spec('c', 3), spec('d', 3)]);
    expect(m.rooms.map((r) => r.side)).toEqual(['north', 'south', 'north', 'south']);
    for (const r of m.rooms) {
      expect(r.x0 + r.w).toBeLessThanOrEqual(m.lounge.x0 + 1);
      expect(r.y0 + r.h).toBeLessThanOrEqual(m.h);
    }
    expect(m.lounge.x0 + m.lounge.w).toBe(m.w);
    expect(m.lobby.w).toBeGreaterThan(8);
  });

  it('room capacity follows the robot count: 2 desks per column, at least 4', () => {
    expect(roomCols(0)).toBe(2);
    expect(roomCols(4)).toBe(2);
    expect(roomCols(5)).toBe(3);
    expect(roomCols(9)).toBe(5);
    const m = buildOffice([spec('a', 9), spec('b', 1)]);
    expect(m.rooms[0]!.desks).toHaveLength(10);
    expect(m.rooms[1]!.desks).toHaveLength(4);
  });

  it('desks and furniture block walking; every seat tile, door, nook and standing spot is walkable and reachable from the elevator', () => {
    const m = buildOffice([spec('a', 7), spec('b', 4), spec('c', 3)]);
    const spawn = m.lobby.spawn;
    expect(isWalkable(m, spawn.x, spawn.y)).toBe(true);
    const targets = [...m.rooms.flatMap((r) => r.desks.map((d) => d.tile)), ...m.rooms.flatMap((r) => r.door), ...m.lounge.nooks.map((n) => n.tile), ...m.lounge.stands.map((s) => s.tile)];
    expect(targets.length).toBeGreaterThan(30);
    for (const t of targets) {
      expect(isWalkable(m, t.x, t.y), `walkable ${t.x},${t.y}`).toBe(true);
      expect(findPath(m, spawn, t), `reachable ${t.x},${t.y}`).not.toBeNull();
    }
    for (const r of m.rooms) for (const d of r.desks) expect(isWalkable(m, d.desk.x, d.desk.y)).toBe(false);
    for (const n of m.lounge.nooks) expect(isWalkable(m, n.nook.x, n.nook.y)).toBe(false);
    expect(tileAt(m, -1, 0)).toBe('void');
    expect(isWalkable(m, m.lobby.elevator.x, m.lobby.elevator.y)).toBe(false);
  });

  it('desks do not overlap, and every seat is directly above its desk (the robot sits behind it)', () => {
    const m = buildOffice([spec('a', 8), spec('b', 8)]);
    for (const r of m.rooms) {
      const seen = new Set<string>();
      for (const d of r.desks) {
        for (const x of [d.desk.x, d.desk.x + 1]) {
          const k = `${x},${d.desk.y}`;
          expect(seen.has(k)).toBe(false);
          seen.add(k);
        }
        expect(d.tile).toEqual({ x: d.desk.x, y: d.desk.y - 1 });
        expect(d.px).toEqual({ x: (d.desk.x + 1) * TILE, y: d.desk.y * TILE + 7 });
      }
    }
  });

  it('the lounge has 8 nooks covering all five kinds of furniture, and room to stand', () => {
    const m = buildOffice([spec('a')]);
    expect(m.lounge.nooks).toHaveLength(8);
    expect(new Set(m.lounge.nooks.map((n) => n.kind))).toEqual(new Set(['couch', 'coffee', 'arcade', 'tv', 'pingpong']));
    expect(m.lounge.stands.length).toBeGreaterThanOrEqual(12);
  });
});

describe('pathfinding', () => {
  const m: OfficeMap = buildOffice([spec('a', 4), spec('b', 4)]);
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
    const s = sceneWith([spec('shop', 4), spec('api', 2)]);
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
    const s = sceneWith([spec('shop', 6), spec('api', 4)]);
    s.sync([robot('r1', 'analyzing', 'shop'), robot('r2', 'idle', 'api')]);
    s.sync([robot('r1', 'idle', 'shop'), robot('r2', 'analyzing', 'api')]);
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
    const s = sceneWith([spec('shop', 2), spec('api', 2)]);
    s.sync([robot('r1', 'analyzing'), robot('r2', 'idle')]);
    s.setMap(buildOffice([spec('shop', 10), spec('api', 2)]));
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
    const s = sceneWith([spec('shop', 4), spec('api', 2)]);
    s.sync([robot('r1', 'idle', 'shop')]);
    run(s, 1);
    expect(s.doorsOpen()).toEqual([]);
    s.sync([robot('r1', 'analyzing', 'shop')]); // walks from the lounge to its room
    const opened = new Set<string>();
    for (let t = 0; t < 40 && s.isWalking(); t += 0.05) {
      s.tick(0.05);
      for (const k of s.doorsOpen(0.5)) opened.add(k);
    }
    expect([...opened]).toContain('shop');
    run(s, 2);
    expect(s.doorsOpen()).toEqual([]);
    const vacant = sceneWith([spec('only', 1)]);
    vacant.sync([robot('x', 'idle', 'only')]);
    vacant.sync([robot('x', 'analyzing', 'only')]);
    run(vacant, 40);
    for (const r of vacant.map.rooms.filter((r) => r.vacant)) expect(vacant.doors.get(r.key)!.open).toBe(0);
  });

  it('a door never opens for a robot far away', () => {
    const s = sceneWith();
    s.sync([robot('r1', 'analyzing', 'shop')]);
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
  const team = () => new OfficeScene(buildOffice([spec('team', 9), spec('shop', 4)]));
  const agent = (id: string, status: RobotStatus, deskIndex: number): RobotInput => ({ ...robot(id, status, 'team'), deskIndex });
  const deskOf = (s: OfficeScene, id: string) => s.actors.get(id)!.goal.key;

  it('seats each agent at the desk it was given, whatever order the robots arrive in', () => {
    const s = team();
    s.sync([agent('quinn', 'analyzing', 1), agent('rhea', 'analyzing', 2), agent('bram', 'analyzing', 7)], { initial: true });
    expect(deskOf(s, 'quinn')).toBe('desk:team:1');
    expect(deskOf(s, 'rhea')).toBe('desk:team:2');
    expect(deskOf(s, 'bram')).toBe('desk:team:7');
    const s2 = team();
    s2.sync([agent('bram', 'analyzing', 7), agent('rhea', 'analyzing', 2), agent('quinn', 'analyzing', 1)], { initial: true });
    expect([deskOf(s2, 'quinn'), deskOf(s2, 'rhea'), deskOf(s2, 'bram')]).toEqual(['desk:team:1', 'desk:team:2', 'desk:team:7']);
  });

  it('keeps empty desks empty (nobody is invented), and the team room has a desk for every role', () => {
    const s = team();
    const room = s.map.rooms.find((r) => r.key === 'team')!;
    expect(room.vacant).toBe(false);
    expect(room.desks.length).toBeGreaterThanOrEqual(9);
    s.sync([agent('quinn', 'analyzing', 1)], { initial: true });
    expect(s.deskOwner('team', 1)?.id).toBe('quinn');
    for (const i of [0, 2, 3, 4, 5, 6, 7, 8]) expect(s.deskOwner('team', i)).toBeUndefined();
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
    expect(deskOf(s, 'quinn')).toBe('desk:team:3');
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

  it('ordinary robots without a fixed desk are unaffected', () => {
    const s = team();
    s.sync([robot('plain', 'analyzing', 'shop')], { initial: true });
    expect(deskOf(s, 'plain')).toBe('desk:shop:0');
  });
});
