/**
 * The living office model: where every robot is and where it is going. Pure logic (no DOM, no clocks, no
 * randomness): time only enters as `dt` passed to `tick`.
 *
 * Rules:
 *  - Who is where is decided by REAL status alone: idle or completed -> a lounge spot; every other status
 *    (working, waiting for the person, failed, disconnected) -> the robot's own desk in its project room.
 *  - A robot walks only when its target changes (a status change, a new session, a layout change).
 *    With no events, nothing moves.
 *  - A robot that appears after the first sync arrives through the elevator. Its subagents (drones) arrive the
 *    same way and hover beside it.
 *  - Desks are reserved per robot while it stays visible, so it returns to the same desk.
 *  - Celebrations (confetti on completed, a rain cloud on failed) happen only when a REAL status change to
 *    that status is observed, never on the first placement. Doors open for whoever is near them.
 */
import type { RobotPalette, RobotStatus, RobotType } from '@qavo/shared';
import { isWalkable, tileFeet, TILE, type NookSlot, type OfficeMap, type Pt, type Seat } from './map.ts';
import { nookForRobot } from '../sprites/nook.ts';
import type { SoundKind } from './sound.ts';
import { findPath } from './path.ts';

export type Zone = 'desk' | 'lounge' | 'walking';
export const WALK_TILES_PER_SEC = 6;
export const DRONE_TILES_PER_SEC = 8;
export const DOOR_RADIUS_PX = 26;
export const DOOR_OPEN_PER_SEC = 5;
export const LIFT_OPEN_SECONDS = 1.6;
export const EFFECT_SECONDS = { confetti: 2.6, rain: 4.2 } as const;
/** Two standing robots this close (px) are chatting. */
export const CHAT_DISTANCE_PX = 40;

export interface RobotInput {
  id: string;
  name: string;
  status: RobotStatus;
  roomKey: string;
  /** A fixed desk in the room (the QA Team room gives every agent its own desk). */
  deskIndex?: number;
  type: RobotType;
  palette: RobotPalette;
  /** Current tool (metadata only), for the activity bubble. */
  activity?: { tool: string; fileCategory: string | null; commandCategory: string | null; at: number } | null;
  /** Subagents currently running. */
  drones?: ReadonlyArray<{ agentId: string; agentType: string; status: RobotStatus }>;
}
type Goal = { key: string; seat: Seat; where: 'desk' | 'lounge' };
export interface Actor {
  id: string;
  /** Feet position in logical pixels. */
  x: number;
  y: number;
  /** Last tile the robot stood on (the start of its next route). */
  tile: Pt;
  waypoints: Pt[];
  goal: Goal;
  zone: Zone;
  input: RobotInput;
  /** Walking-bob phase (advances only while walking). */
  phase: number;
}
export interface DroneActor {
  key: string;
  parentId: string;
  agentId: string;
  agentType: string;
  status: RobotStatus;
  slot: number;
  x: number;
  y: number;
  /** True while flying in from the elevator. */
  arriving: boolean;
}
export interface Effect {
  kind: 'confetti' | 'rain';
  actorId: string;
  t0: number;
  dur: number;
}
interface Door {
  open: number;
  target: number;
}

export const isRestingStatus = (s: RobotStatus): boolean => s === 'idle' || s === 'completed';
const tileOfPx = (p: Pt): Pt => ({ x: Math.floor(p.x / TILE), y: Math.floor(p.y / TILE) });

export class OfficeScene {
  map: OfficeMap;
  readonly actors = new Map<string, Actor>();
  readonly drones = new Map<string, DroneActor>();
  effects: Effect[] = [];
  /** Scene clock in seconds (advances only through `tick`). */
  time = 0;
  /** Sounds waiting to be played (only ever added for REAL changes; the view drains it). */
  private sounds: SoundKind[] = [];
  /** Door openness 0..1 per room key. */
  readonly doors = new Map<string, Door>();
  lift = { open: 0, until: -1 };
  /** Bumped whenever a robot changes zone or a drone arrives (for observers that must not poll every frame). */
  version = 0;
  private home = new Map<string, { roomKey: string; index: number }>();
  private loungeSlot = new Map<string, { kind: 'nook' | 'stand'; index: number }>();
  private synced = false;

  constructor(map: OfficeMap) {
    this.map = map;
  }

  /** Replaces the building (a room appeared, or a room needed more desks). Robots are re-seated in place, not walked. */
  setMap(map: OfficeMap): void {
    this.map = map;
    for (const a of this.actors.values()) this.snapTo(a, this.goalFor(a.input));
    for (const d of this.drones.values()) this.placeDroneAtHover(d);
    this.doors.clear();
    this.version++;
  }

  // ------------------------------------------------------------------ targets
  private deskFor(input: RobotInput): { roomKey: string; index: number; seat: Seat } {
    const room = this.map.rooms.find((r) => r.key === input.roomKey && !r.vacant) ?? this.map.rooms.find((r) => r.key === 'unassigned' && !r.vacant) ?? this.map.rooms.find((r) => !r.vacant);
    if (!room || room.desks.length === 0) {
      const fallback = this.map.lounge.stands[0]!;
      return { roomKey: input.roomKey, index: 0, seat: fallback };
    }
    const cur = this.home.get(input.id);
    const taken = new Set([...this.home.entries()].filter(([id, h]) => id !== input.id && h.roomKey === room.key).map(([, h]) => h.index));
    const want = input.deskIndex !== undefined && input.deskIndex < room.desks.length && !taken.has(input.deskIndex) ? input.deskIndex : -1;
    let index = want >= 0 ? want : cur && cur.roomKey === room.key && cur.index < room.desks.length && !taken.has(cur.index) ? cur.index : -1;
    if (index < 0) index = room.desks.findIndex((d) => !taken.has(d.index));
    if (index < 0) index = room.desks.length - 1;
    this.home.set(input.id, { roomKey: room.key, index });
    return { roomKey: room.key, index, seat: room.desks[index]! };
  }

  private loungeFor(input: RobotInput): { key: string; seat: Seat } {
    const { nooks, stands } = this.map.lounge;
    const used = new Set([...this.loungeSlot.entries()].filter(([id]) => id !== input.id).map(([, s]) => `${s.kind}:${s.index}`));
    const cur = this.loungeSlot.get(input.id);
    if (cur && !used.has(`${cur.kind}:${cur.index}`) && (cur.kind === 'nook' ? cur.index < nooks.length : cur.index < stands.length)) {
      return { key: `${cur.kind}:${cur.index}`, seat: cur.kind === 'nook' ? nooks[cur.index]! : stands[cur.index]! };
    }
    const preferred = nookForRobot(input.id);
    const free = (n: NookSlot) => !used.has(`nook:${n.index}`);
    const nook = nooks.find((n) => n.kind === preferred && free(n)) ?? nooks.find(free);
    if (nook) {
      this.loungeSlot.set(input.id, { kind: 'nook', index: nook.index });
      return { key: `nook:${nook.index}`, seat: nook };
    }
    let si = stands.findIndex((_, i) => !used.has(`stand:${i}`));
    if (si < 0) si = stands.length - 1;
    this.loungeSlot.set(input.id, { kind: 'stand', index: si });
    return { key: `stand:${si}`, seat: stands[si]! };
  }

  private goalFor(input: RobotInput): Goal {
    if (isRestingStatus(input.status)) {
      const l = this.loungeFor(input);
      return { key: `lounge:${l.key}`, seat: l.seat, where: 'lounge' };
    }
    this.loungeSlot.delete(input.id);
    const d = this.deskFor(input);
    return { key: `desk:${d.roomKey}:${d.index}`, seat: d.seat, where: 'desk' };
  }

  // ------------------------------------------------------------------ sync (event-driven)
  /** Applies the latest real robot states. Only a changed target makes a robot walk; only a real status change celebrates. */
  sync(inputs: readonly RobotInput[], opts: { reducedMotion?: boolean; initial?: boolean } = {}): void {
    const ids = new Set(inputs.map((i) => i.id));
    for (const id of [...this.actors.keys()]) {
      if (!ids.has(id)) {
        this.actors.delete(id);
        this.home.delete(id);
        this.loungeSlot.delete(id);
        this.effects = this.effects.filter((e) => e.actorId !== id);
        this.version++;
      }
    }
    const live = this.synced && !opts.initial; // a real change after the first placement
    const arrivals = live && !opts.reducedMotion;
    for (const input of inputs) {
      const goal = this.goalFor(input);
      const actor = this.actors.get(input.id);
      if (!actor) {
        const a: Actor = { id: input.id, x: goal.seat.px.x, y: goal.seat.px.y, tile: goal.seat.tile, waypoints: [], goal, zone: goal.where, input, phase: 0 };
        this.actors.set(input.id, a);
        if (live) this.sounds.push('arrive');
        if (arrivals) {
          const spawn = this.map.lobby.spawn;
          const f = tileFeet(spawn);
          a.x = f.x;
          a.y = f.y;
          a.tile = spawn;
          this.route(a, goal);
          this.lift.until = this.time + LIFT_OPEN_SECONDS;
        }
        this.version++;
        continue;
      }
      const prevStatus = actor.input.status;
      actor.input = input;
      if (live && prevStatus !== input.status) {
        if (input.status === 'completed') this.sounds.push('complete');
        else if (input.status === 'failed') this.sounds.push('fail');
        else if (input.status === 'awaiting_permission' || input.status === 'awaiting_input') this.sounds.push('alert');
      }
      if (!opts.reducedMotion && !opts.initial && prevStatus !== input.status) {
        if (input.status === 'completed') this.effects.push({ kind: 'confetti', actorId: input.id, t0: this.time, dur: EFFECT_SECONDS.confetti });
        else if (input.status === 'failed') this.effects.push({ kind: 'rain', actorId: input.id, t0: this.time, dur: EFFECT_SECONDS.rain });
      }
      if (actor.goal.key !== goal.key) {
        if (opts.reducedMotion) this.snapTo(actor, goal);
        else this.route(actor, goal);
        this.version++;
      }
    }
    this.syncDrones(inputs, arrivals);
    this.synced = true;
  }

  private droneHover(parent: Actor, slot: number): Pt {
    return { x: parent.x - 15 - slot * 9, y: parent.y - 20 - (slot % 2) * 6 };
  }
  private placeDroneAtHover(d: DroneActor): void {
    const p = this.actors.get(d.parentId);
    if (!p) return;
    const h = this.droneHover(p, d.slot);
    d.x = h.x;
    d.y = h.y;
    d.arriving = false;
  }
  private syncDrones(inputs: readonly RobotInput[], arrivals: boolean): void {
    const want = new Map<string, { input: RobotInput; agentId: string; agentType: string; status: RobotStatus; slot: number }>();
    for (const input of inputs) (input.drones ?? []).forEach((d, slot) => want.set(`${input.id}:${d.agentId}`, { input, agentId: d.agentId, agentType: d.agentType, status: d.status, slot }));
    for (const key of [...this.drones.keys()]) {
      if (!want.has(key)) {
        this.drones.delete(key);
        this.version++;
      }
    }
    for (const [key, w] of want) {
      const existing = this.drones.get(key);
      if (existing) {
        existing.status = w.status;
        existing.slot = w.slot;
        continue;
      }
      const d: DroneActor = { key, parentId: w.input.id, agentId: w.agentId, agentType: w.agentType, status: w.status, slot: w.slot, x: 0, y: 0, arriving: false };
      this.drones.set(key, d);
      if (arrivals) {
        const f = tileFeet(this.map.lobby.spawn);
        d.x = f.x;
        d.y = f.y - 10;
        d.arriving = true;
        this.lift.until = this.time + LIFT_OPEN_SECONDS;
      } else this.placeDroneAtHover(d);
      this.version++;
    }
  }

  private snapTo(a: Actor, goal: Goal): void {
    a.goal = goal;
    a.x = goal.seat.px.x;
    a.y = goal.seat.px.y;
    a.tile = goal.seat.tile;
    a.waypoints = [];
    a.zone = goal.where;
  }

  private route(a: Actor, goal: Goal): void {
    a.goal = goal;
    const start = isWalkable(this.map, a.tile.x, a.tile.y) ? a.tile : tileOfPx({ x: a.x, y: a.y });
    const path = findPath(this.map, start, goal.seat.tile);
    if (!path) return this.snapTo(a, goal);
    a.waypoints = [...path.map(tileFeet), goal.seat.px];
    a.zone = 'walking';
  }

  // ------------------------------------------------------------------ time
  /** Advances walking, drones, doors and effects by `dt` seconds. Returns true when any robot arrived. */
  tick(dt: number): boolean {
    this.time += dt;
    let changed = false;
    const step = WALK_TILES_PER_SEC * TILE * dt;
    for (const a of this.actors.values()) {
      if (a.waypoints.length === 0) continue;
      let budget = step;
      while (budget > 0 && a.waypoints.length > 0) {
        const t = a.waypoints[0]!;
        const dx = t.x - a.x;
        const dy = t.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d <= budget) {
          a.x = t.x;
          a.y = t.y;
          budget -= d;
          a.waypoints.shift();
          if (a.waypoints.length > 0) a.tile = tileOfPx({ x: a.x, y: a.y });
        } else {
          a.x += (dx / d) * budget;
          a.y += (dy / d) * budget;
          budget = 0;
        }
      }
      a.phase += dt;
      if (a.waypoints.length === 0) {
        a.zone = a.goal.where;
        a.tile = a.goal.seat.tile;
        changed = true;
        this.version++;
      }
    }
    this.tickDrones(dt);
    this.tickDoors(dt);
    this.effects = this.effects.filter((e) => this.time - e.t0 <= e.dur);
    return changed;
  }

  private tickDrones(dt: number): void {
    const step = DRONE_TILES_PER_SEC * TILE * dt;
    for (const d of this.drones.values()) {
      const p = this.actors.get(d.parentId);
      if (!p) continue;
      const h = this.droneHover(p, d.slot);
      const dx = h.x - d.x;
      const dy = h.y - d.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= step) {
        d.x = h.x;
        d.y = h.y;
        if (d.arriving) {
          d.arriving = false;
          this.version++;
        }
      } else {
        d.x += (dx / dist) * step;
        d.y += (dy / dist) * step;
      }
    }
  }

  private tickDoors(dt: number): void {
    const speed = DOOR_OPEN_PER_SEC * dt;
    for (const r of this.map.rooms) {
      let door = this.doors.get(r.key);
      if (!door) {
        door = { open: 0, target: 0 };
        this.doors.set(r.key, door);
      }
      const cx = (r.door[0]!.x + 1) * TILE;
      const cy = (r.door[0]!.y + 0.5) * TILE;
      let near = false;
      if (!r.vacant) for (const a of this.actors.values()) if (Math.hypot(a.x - cx, a.y - TILE * 0.4 - cy) <= DOOR_RADIUS_PX) near = true;
      door.target = near ? 1 : 0;
      door.open = door.open < door.target ? Math.min(door.target, door.open + speed) : Math.max(door.target, door.open - speed);
    }
    const liftTarget = this.time < this.lift.until ? 1 : 0;
    this.lift.open = this.lift.open < liftTarget ? Math.min(liftTarget, this.lift.open + speed) : Math.max(liftTarget, this.lift.open - speed);
  }

  // ------------------------------------------------------------------ queries
  /** The robot that owns a desk (even while it is away resting), if any. */
  deskOwner(roomKey: string, index: number): Actor | undefined {
    for (const [id, h] of this.home) if (h.roomKey === roomKey && h.index === index) return this.actors.get(id);
    return undefined;
  }
  isWalking = (): boolean => [...this.actors.values()].some((a) => a.waypoints.length > 0);
  /** True while anything on screen is changing by itself (walking, flying drones, doors, lift, effects). */
  isAnimating(): boolean {
    if (this.isWalking() || this.effects.length > 0) return true;
    if ([...this.drones.values()].some((d) => d.arriving || this.droneMoving(d))) return true;
    if (this.lift.open !== (this.time < this.lift.until ? 1 : 0)) return true;
    for (const d of this.doors.values()) if (d.open !== d.target) return true;
    return false;
  }
  private droneMoving(d: DroneActor): boolean {
    const p = this.actors.get(d.parentId);
    if (!p) return false;
    const h = this.droneHover(p, d.slot);
    return Math.abs(h.x - d.x) > 0.01 || Math.abs(h.y - d.y) > 0.01;
  }
  /** Standing robots in the lounge who have a neighbour close by (a chat). */
  chatting(): Set<string> {
    const standing = [...this.actors.values()].filter((a) => a.waypoints.length === 0 && a.goal.where === 'lounge' && a.goal.key.startsWith('lounge:stand:'));
    const out = new Set<string>();
    for (let i = 0; i < standing.length; i++) {
      for (let j = i + 1; j < standing.length; j++) {
        if (Math.hypot(standing[i]!.x - standing[j]!.x, standing[i]!.y - standing[j]!.y) <= CHAT_DISTANCE_PX) {
          out.add(standing[i]!.id);
          out.add(standing[j]!.id);
        }
      }
    }
    return out;
  }
  /** Takes the sounds that are waiting (so a sound is never played twice, and none pile up while sound is off). */
  drainSounds(): SoundKind[] {
    const out = this.sounds;
    this.sounds = [];
    return out;
  }
  effectsOf(actorId: string): Effect[] {
    return this.effects.filter((e) => e.actorId === actorId);
  }
  snapshot(): Array<{ id: string; name: string; status: RobotStatus; zone: Zone; room: string; x: number; y: number }> {
    return [...this.actors.values()]
      .map((a) => ({ id: a.id, name: a.input.name, status: a.input.status, zone: a.zone, room: a.input.roomKey, x: Math.round(a.x), y: Math.round(a.y) }))
      .sort((p, q) => p.id.localeCompare(q.id));
  }
  droneSnapshot(): Array<{ key: string; parent: string; agentId: string; status: RobotStatus; state: 'flying' | 'hover' }> {
    return [...this.drones.values()].map((d) => ({ key: d.key, parent: d.parentId, agentId: d.agentId, status: d.status, state: d.arriving ? ('flying' as const) : ('hover' as const) })).sort((a, b) => a.key.localeCompare(b.key));
  }
  doorsOpen(threshold = 0.05): string[] {
    return [...this.doors.entries()].filter(([, d]) => d.open > threshold).map(([k]) => k).sort();
  }
}
