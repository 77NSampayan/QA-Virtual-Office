/** Shortest walkable route between two tiles (4-neighbour breadth-first search; deterministic tie-breaking). */
import { isWalkable, type OfficeMap, type Pt } from './map.ts';

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Tiles from `from` (exclusive) to `to` (inclusive); [] when already there; null when unreachable. */
export function findPath(map: OfficeMap, from: Pt, to: Pt): Pt[] | null {
  if (from.x === to.x && from.y === to.y) return [];
  if (!isWalkable(map, to.x, to.y)) return null;
  const key = (x: number, y: number) => y * map.w + x;
  const prev = new Map<number, number>();
  const seen = new Set<number>([key(from.x, from.y)]);
  const queue: Pt[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    for (const [dx, dy] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const k = key(nx, ny);
      if (seen.has(k) || !isWalkable(map, nx, ny)) continue;
      seen.add(k);
      prev.set(k, key(cur.x, cur.y));
      if (nx === to.x && ny === to.y) {
        const out: Pt[] = [];
        for (let c: number | undefined = k; c !== undefined && c !== key(from.x, from.y); c = prev.get(c)) out.push({ x: c % map.w, y: Math.floor(c / map.w) });
        return out.reverse();
      }
      queue.push({ x: nx, y: ny });
    }
  }
  return null;
}
